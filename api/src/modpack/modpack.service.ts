import { Inject, Injectable } from '@nestjs/common';
import { Modpack } from './modpack.entity';
import { MODPACK_REPOSITORY } from './modpack.constants';
import { generateId } from '../utils/generic-utils';
import { ModLoader } from '../../../common/modloaders';
import { ModDiscoveryService } from '../mod/mod-discovery.service';
import { uniq } from 'lodash';
import { QueryTypes, Sequelize } from 'sequelize';
import ModpackMod from './modpack-mod.entity';
import * as minecraftVersions from '../../../common/minecraft-versions.json';
import { minecraftVersionComparator, parseMinecraftVersion } from '../utils/minecraft-utils';
import { ModJar } from '../mod/mod-jar.entity';
import { InjectSequelize } from '../database/database.providers';
import { getMostCompatibleMcVersion, isMcVersionLikelyCompatibleWith } from '../../../common/minecraft-utils';
import { ModService } from '../mod/mod.service';
import * as childProcess from 'child_process';
import * as fsCb from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as assert from 'assert';
import * as rimrafCb from 'rimraf';
import * as nodeUtils from 'util';

const rimraf = nodeUtils.promisify(rimrafCb);

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
    private modService: ModService,
    @InjectSequelize private sequelize: Sequelize,
  ) {
  }

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
    // TODO: use DataLoader
    return Modpack.findOne({ where: { externalId } });
  }

  async addModUrlsToModpack(modpack: Modpack, byUrl: string[]): Promise<Modpack> {
    // TODO: transaction

    const {
      availableCurseProjectIds,
      pendingCurseProjectIds,
      unknownUrls,
    } = await this.modDiscoveryService.discoverUrls(byUrl);

    if (pendingCurseProjectIds.length > 0) {
      modpack.pendingCurseForgeProjectIds = uniq([...modpack.pendingCurseForgeProjectIds, ...pendingCurseProjectIds]);
    }

    await Promise.all(availableCurseProjectIds.map(projectId => {
      return this.addCurseProjectToModpack(modpack, projectId);
    }));

    // TODO: return unknownUrls to front

    return modpack.save();
  }

  async addCurseProjectToModpack(modpack: Modpack, curseProjectId: number): Promise<Modpack> {
    const validMcVersions = getPreferredMinecraftVersions(modpack.minecraftVersion, minecraftVersions);

    type TQueryOutput = {
      jarId: number,
      modId: string,
      supportedMinecraftVersions: string,
    };

    // this query selects every modId found on the Curse Project Page matching curseProjectId
    //  and returns the ID of the Jar that contains the best available version of that ModId, for the given modpack
    // It does so by partitioning the list of mods by modID
    //  sorting each partition by whether the mod would be a good fit or not
    //  then picks the first (so, best fitting) item of each partition
    const jarCandidates = await this.sequelize.query<TQueryOutput>(`
      SELECT "jarId", "modId", "supportedMinecraftVersions"
      FROM (
        SELECT j."internalId" as "jarId",
          v."modId",
          v."supportedMinecraftVersions",
            row_number() over (
            PARTITION BY "modId"
            ORDER BY 
              ${validMcVersions.map((mcVersion, index) => {
      const versions = [];
      for (let i = 0; i <= index; i++) {
        versions.push(validMcVersions[i]);
      }
      const versionStr = versions.map(v => `'${v}'`).join(',');

      // We generate something that looks like: (modpack is 1.16.5)
      //   ORDER BY v."supportedMinecraftVersions"::text[] && ARRAY ['1.16.5'] DESC,
      //     v."supportedMinecraftVersions"::text[] && ARRAY ['1.16.5', '1.16.4'] DESC,
      //     v."supportedMinecraftVersions"::text[] && ARRAY ['1.16.5', '1.16.4', '1.16.3'] DESC,
      // We have to repeat previous version in the overlap, otherwise 
      //  a version that that supports 1.16.5 + 1.16.3 but was released *before*
      //  a version that only supports 1.16.5 would be selected.

      return `v."supportedMinecraftVersions"::text[] && ARRAY[${versionStr}] DESC,\n`;
    }).join('')}
              v."supportedModLoader" = :modLoader DESC,
              j."releaseType" = 'STABLE' DESC,
              j."releaseType" = 'BETA' DESC,
              j."releaseType" = 'ALPHA' DESC,
              j."releaseDate" DESC
            )
        FROM "ModJars" j
          LEFT JOIN "ModVersions" v on j."internalId" = v."jarId"
        WHERE "curseProjectId" = :curseProjectId
      ) sub1
      WHERE sub1.row_number = 1
    `, {
      type: QueryTypes.SELECT,
      replacements: {
        curseProjectId,
        modLoader: modpack.modLoader,
      },
    });

    // FIXME: adding total darkness adds both 1.2.1 & 1.1.1
    //  https://www.curseforge.com/minecraft/mc-mods/total-darkness/files
    //  - one mod supports both fabric & forge
    //  - the other only forge
    //  - the fabric id is different from the forge id

    // We only add the mods for *one* minecraft version
    // so first, determine which minecraft version would be the best available for this mod

    const allMcVersions = new Set<string>();
    for (const candidate of jarCandidates) {
      for (const version of candidate.supportedMinecraftVersions) {
        allMcVersions.add(version);
      }
    }

    const idealAvailableMcVersion = getMostCompatibleMcVersion(modpack.minecraftVersion, Array.from(allMcVersions));
    const jarIds = new Set<number>();

    for (const candidate of jarCandidates) {
      for (const version of candidate.supportedMinecraftVersions) {
        // if "idealAvailableMcVersion" is 1.16.4,
        // add all jars that declare support for [1.16, 1.16.4]
        if (isMcVersionLikelyCompatibleWith(idealAvailableMcVersion, version)) {
          jarIds.add(candidate.jarId);
          break;
        }
      }
    }

    // @ts-ignore
    await ModpackMod.bulkCreate(Array.from(jarIds).map(jarId => {
      return {
        modpackId: modpack.internalId,
        jarId,
      };
    }), {
      updateOnDuplicate: ['jarId', 'modpackId'],
    });

    return modpack;
  }

  async getModIdBestMatchForModpack(modpack: Modpack, modId: string): Promise<ModJar> {
    const validMcVersions = getPreferredMinecraftVersions(modpack.minecraftVersion, minecraftVersions);

    return ModJar.findOne({
      include: [{
        association: ModJar.associations.mods,
        required: true,
        where: {
          modId,
        },
      }],
      order: Sequelize.literal(`
        ${validMcVersions.map((mcVersion, index) => {
        // See #addCurseProjectToModpack for info about this
        const versions = [];
        for (let i = 0; i <= index; i++) {
          versions.push(validMcVersions[i]);
        }
        const versionStr = versions.map(v => `'${v}'`).join(',');
        return `mods."supportedMinecraftVersions"::text[] && ARRAY[${versionStr}] DESC,\n`;
      }).join('')}
        mods."supportedModLoader" = :modLoader DESC,
        "releaseType" = 'STABLE' DESC,
        "releaseType" = 'BETA' DESC,
        "releaseType" = 'ALPHA' DESC,
        "releaseDate" DESC
      `),
      subQuery: false,
      replacements: {
        modLoader: modpack.modLoader,
      },
    });
  }

  /**
   * Adds our best matching available mod version to the modpack
   *
   * It tries to find one using the following criteria
   * - A version that matches the minecraft version
   * - A version that matches the modLoader
   * - STABLE first, then BETA, then ALPHA
   * - The most recent file
   *
   * @param {Modpack} modpack
   * @param {string} modId
   * @returns {Promise<void>}
   */
  async addModIdToModpack(modpack: Modpack, modId: string): Promise<Modpack> {

    const installedModVersion = await ModpackMod.findOne({
      where: {
        modpackId: modpack.internalId,
      },
      include: [{
        association: ModpackMod.associations.jar,
        required: true,
        include: [{
          association: ModJar.associations.mods,
          required: true,
          where: {
            modId,
          },
        }],
      }],
    });

    if (installedModVersion != null) {
      return modpack;
    }

    const mod = await this.getModIdBestMatchForModpack(modpack, modId);

    if (!mod) {
      throw new Error(`Could not find any valid mod for ${modId}`);
    }

    // @ts-ignore
    await ModpackMod.create({
      modpackId: modpack.internalId,
      jarId: mod.internalId,
    });

    return modpack;
  }

  getModpackInstalledJars(modpack: Modpack): Promise<ModpackMod[]> {
    return modpack.$get('installedMods', {
      include: [{
        association: ModpackMod.associations.jar,
      }],
      order: [['createdAt', 'ASC']],
    });
  }

  getModpackJars(modpack: Modpack): Promise<ModJar[]> {
    return ModJar.findAll({
      include: [{
        association: ModJar.associations.mods,
        required: true,
      }, {
        association: ModJar.associations.inModpacks,
        required: true,
        include: [{
          association: ModpackMod.associations.modpack,
          required: true,
          where: {
            internalId: modpack.internalId,
          },
        }],
      }],
    });
  }

  async removeJarFromModpack(modpack: Modpack, jar: ModJar) {
    return ModpackMod.destroy({
      where: {
        modpackId: modpack.internalId,
        jarId: jar.internalId,
      },
    });
  }

  async setModpackJarIsLibrary(modpack: ModJar | Modpack, jar: ModJar | Modpack, isLibrary: boolean) {
    const modpackMod: ModpackMod = await ModpackMod.findOne({
      where: {
        modpackId: modpack.internalId,
        jarId: jar.internalId,
      },
    });

    if (modpackMod == null) {
      return null;
    }

    if (modpackMod.isLibraryDependency !== isLibrary) {
      modpackMod.isLibraryDependency = isLibrary;
      await modpackMod.save();
    }

    return modpackMod;
  }

  async downloadModpackToFileStream(modpack: Modpack): Promise<NodeJS.ReadableStream> {
    const dbJars = (await this.getModpackJars(modpack)).filter(jar => {
      assert(jar.mods != null && jar.mods.length > 0, 'downloadModpackToFileStream: expected jar to eagerly include mods');

      let containsCompatibleMod = false;
      for (const mod of jar.mods) {
        // mod.supportedModLoader
        if (mod.supportedModLoader !== modpack.modLoader) {
          continue;
        }

        const mostCompatible = getMostCompatibleMcVersion(modpack.minecraftVersion, mod.supportedMinecraftVersions);
        if (!isMcVersionLikelyCompatibleWith(modpack.minecraftVersion, mostCompatible)) {
          continue;
        }

        containsCompatibleMod = true;
        break;
      }

      return containsCompatibleMod;
    });

    // TODO use tmp package
    const outputZipFile = path.resolve('tmp-zip.zip');

    // TODO use tmp package
    const tmpModpackDir = path.resolve('.tmp-zip-dir');
    const modsDir = path.join(tmpModpackDir, 'mods');

    await fs.mkdir(modsDir, { recursive: true });

    const fsFiles = await Promise.all(dbJars.map(async dbJar => {
      const fsFile = await this.modService.downloadJarToFsPath(dbJar);

      const fsSafeFileName = slugifyJarForFs(dbJar.fileName);
      assert(fsSafeFileName.length > 0, `fsSafeFileName is empty for input ${dbJar.fileName}`);

      // TODO: rename if file exists
      const outFile = path.join(modsDir, fsSafeFileName);

      await fs.symlink(fsFile, outFile);
    }));

    const modsDirRel = path.relative(tmpModpackDir, modsDir);

    await new Promise<void>((resolve, reject) => {
      const command = `cd ${tmpModpackDir} && zip ${path.relative(tmpModpackDir, outputZipFile)} -r ${modsDirRel}`;
      childProcess.exec(command, (error, stdout, stderr) => {
        console.log(stdout);
        console.error(stderr);

        if (error) {
          return void reject(error);
        }

        resolve();
      });
    });

    await rimraf(tmpModpackDir);

    return fsCb.createReadStream(outputZipFile);
  }

  async replaceModpackJar(modpack: Modpack, oldJar: ModJar, newJar: ModJar): Promise<void> {
    return this.sequelize.transaction(async transaction => {
      const oldInstalledJar: ModpackMod = await ModpackMod.findOne({
        where: {
          jarId: oldJar.internalId,
          modpackId: modpack.internalId,
        },
        transaction,
      });

      if (!oldInstalledJar) {
        // TODO: throw ServiceError
        throw new Error('Old jar missing');
      }

      await Promise.all([
        // @ts-expect-error
        ModpackMod.create({
          jarId: newJar.internalId,
          modpackId: modpack.internalId,
          createdAt: oldInstalledJar.createdAt,
          isLibraryDependency: oldInstalledJar.isLibraryDependency,
        }, { transaction }),
        oldInstalledJar.destroy({ transaction }),
      ]);
    });
  }
}

function slugifyJarForFs(input: string) {
  const extname = path.extname(input);
  if (extname === '.jar') {
    input = input.substring(0, input.length - extname.length);
  }

  // whitelist alphanumeric
  return (input.replace(/[^a-zA-Z0-9_\-.]/g, '-')
    // remove consecutive -
    .replace(/-+/g, '-')
    // remove start & end -
    .replace(/^-*/, '')
    .replace(/-*$/, '')) + '.jar';
}

export function getPreferredMinecraftVersions(mainVersionStr: string, existingMcVersions: string[]) {
  const validMcVersions = [mainVersionStr];
  const mainVersion = parseMinecraftVersion(mainVersionStr);

  for (const versionStr of existingMcVersions) {
    const version = parseMinecraftVersion(versionStr);

    if (version.major === mainVersion.major && version.minor <= mainVersion.minor) {
      validMcVersions.push(versionStr);
    }
  }

  validMcVersions.sort(minecraftVersionComparator('DESC'));

  return validMcVersions;
}
