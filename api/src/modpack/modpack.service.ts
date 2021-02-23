import { Injectable, Inject } from '@nestjs/common';
import { Modpack } from './modpack.entity';
import { MODPACK_REPOSITORY } from './modpack.constants';
import { generateId } from '../utils/generic-utils';
import { ModLoader } from '../../../common/modloaders';
import { ModDiscoveryService } from '../mod/mod-discovery.service';

type TCreateModpackInput = {
  name: string,
  modLoader: ModLoader,
  minecraftVersion: string,
};

@Injectable()
export class ModpackService {
  constructor(
    @Inject(MODPACK_REPOSITORY) private modpackRepository: typeof Modpack,
    private modDiscoveryService: ModDiscoveryService,
  ) {}

  async getModpacks(): Promise<Modpack[]> {
    return this.modpackRepository.findAll<Modpack>();
  }

  async createModpack(input: TCreateModpackInput): Promise<Modpack> {
    // @ts-ignore
    return Modpack.create({
      ...input,
      externalId: generateId(),
    });
  }

  getModpackByEid(externalId: string) {
    return Modpack.findOne({ where: { externalId }});
  }

  async addModUrlsToModpack(modpack: Modpack, byUrl: string[]): Promise<Modpack> {
    const allUrls = new Set([...modpack.queuedUrls, ...byUrl]);

    // TODO: if there is a version available for the given CURSEFORGE URL, add that version
    //  otherwise, queue
    modpack.queuedUrls = Array.from(allUrls.values());

    await this.modDiscoveryService.discoverUrls(byUrl);

    return modpack.save();
  }
}