import type{EditingSession}from'./office.js';
export type ArtifactField={id:string;label:string;text:string;kind:'text'|'number'|'boolean';readonly?:string;group?:string};
export type ArtifactModel={format:'text'|'docx'|'xlsx'|'pptx'|'pdf'|'image';text?:string;fields:ArtifactField[];warnings:string[];readonly?:string;pages?:number};
export type ArtifactChanges={text?:string;fields?:Record<string,{text:string;kind:'text'|'number'|'boolean'}>};
export type ArtifactDraft={sourceVersion:string;expectedDigest:string;changes:ArtifactChanges;updatedAt:string;binaryVersion?:string};
export type ArtifactVersion={id:string;digest:string;size:number;at:string;label:string};
export type ArtifactComment={id:string;at:string;text:string;anchor:string;field?:string;quote?:string;digest:string;resolved:boolean};
export type ArtifactState={version:1;revision:number;id:string;cwd:string;canonical:string;path:string;versions:ArtifactVersion[];comments:ArtifactComment[];draft?:ArtifactDraft;saveIntent?:{id:string;inputRevision:number;sourceDigest:string;candidateDigest:string;at:string};lastSave?:{id:string;inputRevision:number;digest:string;at:string}};
export type ArtifactView={id:string;threadId:string;path:string;name:string;revision:number;model:ArtifactModel;draft?:ArtifactDraft;versions:ArtifactVersion[];comments:ArtifactComment[];sourceDigest:string;currentDigest:string;conflict:boolean;notice?:string;editing?:EditingSession;storage?:{bytes:number;versions:number}};
