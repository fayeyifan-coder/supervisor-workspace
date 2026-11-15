export const channels = {
  read: "sample-record:read",
  save: "sample-record:save",
} as const;

export interface SampleRecord {
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SaveSample {
  content: string;
  expectedRevision: number | null;
}

export interface DatabaseDetails {
  databasePath: string;
  schemaVersion: number;
  sqliteVersion: string;
}

export type Failure = { ok: false; message: string };
export type Result<T> = { ok: true; value: T } | Failure;

export interface WorkspaceApi {
  read(): Promise<Result<DatabaseDetails & { record: SampleRecord | null }>>;
  save(input: SaveSample): Promise<Result<SampleRecord>>;
}
