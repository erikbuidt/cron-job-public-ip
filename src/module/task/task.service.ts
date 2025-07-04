import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AxiosResponse } from 'axios';
import { Observable, concatMap, firstValueFrom, forkJoin } from 'rxjs';
import {
  CloudflareDomain,
  CloudflareZone,
  PatchDNSResponse,
  SingleCloudflareDomain,
} from 'src/shared/cloudflare.type';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);
  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {
    this.processGetIP();
    this.processIPToDomain();
  }

  async processIPToDomain() {
    const token = this.config.get<string>('cloudflare.dnsEditToken');
    // GetZones
    const listZones = this.config
      .get<string>('cloudflare.zoneNames')
      .replaceAll(' ', '')
      .split(',');

    const ip = await firstValueFrom(this.getPublicIP());
    let cloudflareZones: CloudflareZone;
    this.http
      .get<CloudflareZone>('https://api.cloudflare.com/client/v4/zones', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      .pipe(
        concatMap((zones) => {
          cloudflareZones = zones.data;
          return forkJoin(
            listZones.map((z) => {
              const zoneID = zones.data.result.find((e) => e.name === z).id;
              return this.http.get<CloudflareDomain>(
                `https://api.cloudflare.com/client/v4/zones/${zoneID}/dns_records`,
                { headers: { Authorization: `Bearer ${token}` } },
              );
            }),
          );
        }),
        concatMap((domainsResponse) => {
          const listObservable: Observable<
            AxiosResponse<PatchDNSResponse, any>
          >[] = [];
          listZones.forEach((name) => {
            let foundDomain: SingleCloudflareDomain;
            domainsResponse.forEach((e) => {
              if (e.data.result.find((f) => f.name === name)) {
                foundDomain = e.data.result.find((f) => f.name === name);
              }
            });
            if (foundDomain && foundDomain.content !== ip.data) {
              const zoneID = cloudflareZones.result.find((e) =>
                foundDomain.name.includes(e.name),
              ).id;
              console.log(zoneID);
              listObservable.push(
                this.http.patch<PatchDNSResponse>(
                  `https://api.cloudflare.com/client/v4/zones/${zoneID}/dns_records/${foundDomain.id}`,
                  {
                    content: ip.data,
                  },
                  {
                    headers: { Authorization: `Bearer ${token}` },
                  },
                ),
              );
            }
          });
          return forkJoin(listObservable);
        }),
      )
      .subscribe((res) => {
        let message = 'Updated ';
        res.forEach((e) => {
          message += `${e.data.result.name}, `;
        });
        message += ` to ${ip.data}`;
        this.sendToDiscord(message);
      });
  }

  async processGetIP() {
    this.getPublicIP()
      .pipe(
        concatMap((ipResult) => {
          return this.sendToDiscord(`'s public ip ${ipResult.data}`);
        }),
      )
      .subscribe();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  handleCron() {
    console.log('Called every 10 minutes');
    this.processIPToDomain();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  handleGetIPCron() {
    this.processGetIP();
  }

  sendToDiscord(message: string) {
    console.log('Notification' + message);
    // const serverName = this.config.get<string>('serverName');
    // const body = {
    //   content: `${serverName}${message}`,
    // };
    // const discordChannel = this.config.get<string>('discord.webhook');

    return '';
  }

  getPublicIP() {
    const host = 'https://api.ipify.org';
    return this.http.get<string>(host);
  }
}
