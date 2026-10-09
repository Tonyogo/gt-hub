export interface ByteRange {
  start: number;
  end: number;
  length: number;
  totalSize: number;
}

export type RangeParseResult =
  | { status: 'valid'; range: ByteRange }
  | { status: 'unsatisfiable'; totalSize: number }
  | null;

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  updatedAt: number;
  extension: string;
}

export interface FileStat {
  exists: boolean;
  isDirectory?: boolean;
  isFile?: boolean;
  size?: number;
  mtime?: number;
}

export interface ListFilesResult {
  success: boolean;
  currentPath: string;
  parentPath: string | null;
  separator: string;
  files: FileItem[];
  error?: string;
}

export interface ReadFileResult {
  success: boolean;
  path: string;
  content?: string;
  size: number;
  isBinary: boolean;
  error?: string;
}
