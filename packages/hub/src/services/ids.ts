import { customAlphabet } from "nanoid";

const rand = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

export function claimId(): string {
  return `clm_${rand()}`;
}

export function handoffId(): string {
  return `hnd_${rand()}`;
}

export function blockerId(): string {
  return `blk_${rand()}`;
}

export function templateId(): string {
  return `tpl_${rand()}`;
}

export function workspaceId(prefix?: string): string {
  return prefix ? `wks_${prefix}_${rand()}` : `wks_${rand()}`;
}

export function projectId(): string {
  return `prj_${rand()}`;
}

export function repoId(): string {
  return `rep_${rand()}`;
}

export function assignmentId(): string {
  return `asn_${rand()}`;
}

export function connectionId(): string {
  return `cnx_${rand()}`;
}
