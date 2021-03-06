import fetch, { RequestInit } from 'node-fetch';
import { ReleaseType } from './mod/mod-jar.entity';

// https://twitchappapi.docs.apiary.io/#/reference/0/

type TSearchModsParams = {
  pageSize: number,
  page: number,
  categoryId?: number,
};

const MINECRAFT_GAME_ID = 432;
const MINECRAFT_MODS_SECTION_ID = 6;

export async function* iterateForgeModList(params: Omit<TSearchModsParams, 'page'>) {
  let page = 0;
  let results;

  do {
    results = await searchCurseForgeModList({
      ...params,
      page,
    });

    for (const result of results) {
      yield result;
    }

    page += 1;
  } while (results.length === params.pageSize);
}

export function searchCurseForgeModList(params: TSearchModsParams) {

  const search = new URLSearchParams({
    gameId: String(MINECRAFT_GAME_ID),
    index: String(params.page * params.pageSize),
    pageSize: String(params.pageSize),
    sectionId: String(MINECRAFT_MODS_SECTION_ID),
    // sort 2 is date modified DESC
    sort: '2',
  });

  if (params.categoryId) {
    search.set('categoryID', String(params.categoryId));
  }

  const uri = `/addon/search?` + search.toString();
  return fetchCurseForge(uri);
}

export function getCurseForgeModCategories() {
  return fetchCurseForge('/category/section/6');
}

export type TCurseProject = {
  id: number,
  name: string,
  // authors
  // attachments
  websiteUrl: string,
};

export type TCurseFile = {
  id: number,
  displayName: string,
  fileName: string,
  fileDate: string,
  fileLength: number,
  releaseType: number,
  fileStatus: number,
  downloadUrl: string,
  isAlternate: boolean,
  alternateFileId: number,
  dependencies: [], // TODO
  isAvailable: boolean,
  modules: Array<{
    foldername: string,
    fingerprint: number,
  }>,
  packageFingerprint: number,
  gameVersion: string[], // "Forge", "1.16.4"
  // installMetadata:
  // serverPackFileId
  // hasInstallScript
  // gameVersionDateReleased
  // gameVersionFlavor
};

export function getCurseForgeModFiles(curseProjectId: number): Promise<TCurseFile[]> {
  return fetchCurseForge(`/addon/${curseProjectId}/files`);
}

export function getCurseForgeProjects(ids: number[]): Promise<TCurseProject[]> {
  return fetchCurseForge(`/addon`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(ids),
  });
}

async function fetchCurseForge<T>(path, options?: RequestInit) {
  const res = await fetch(`https://addons-ecs.forgesvc.net/api/v2${path}`, options);

  if (!res.ok) {
    throw new Error(`Could not fetch curseforge ${path}: ${res.status} - ${res.statusText} ` + await res.text());
  }

  return res.json();
}

export function getCurseReleaseType(releaseTypeId: number): ReleaseType {
  switch (releaseTypeId) {
    case 1: return ReleaseType.STABLE;
    case 2: return ReleaseType.BETA;
    case 3: return ReleaseType.ALPHA;
    default: throw new Error('Unknown Curse release type ID ' + releaseTypeId);
  }
}
