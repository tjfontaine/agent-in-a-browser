/** @module Interface wasi:filesystem/types@0.2.6 **/
export function filesystemErrorCode(err: Error): ErrorCode | undefined;
/**
 * # Variants
 * 
 * ## `"unknown"`
 * 
 * ## `"block-device"`
 * 
 * ## `"character-device"`
 * 
 * ## `"directory"`
 * 
 * ## `"fifo"`
 * 
 * ## `"symbolic-link"`
 * 
 * ## `"regular-file"`
 * 
 * ## `"socket"`
 */
export type DescriptorType = 'unknown' | 'block-device' | 'character-device' | 'directory' | 'fifo' | 'symbolic-link' | 'regular-file' | 'socket';
export interface DirectoryEntry {
  type: DescriptorType,
  name: string,
}
/**
 * # Variants
 * 
 * ## `"access"`
 * 
 * ## `"would-block"`
 * 
 * ## `"already"`
 * 
 * ## `"bad-descriptor"`
 * 
 * ## `"busy"`
 * 
 * ## `"deadlock"`
 * 
 * ## `"quota"`
 * 
 * ## `"exist"`
 * 
 * ## `"file-too-large"`
 * 
 * ## `"illegal-byte-sequence"`
 * 
 * ## `"in-progress"`
 * 
 * ## `"interrupted"`
 * 
 * ## `"invalid"`
 * 
 * ## `"io"`
 * 
 * ## `"is-directory"`
 * 
 * ## `"loop"`
 * 
 * ## `"too-many-links"`
 * 
 * ## `"message-size"`
 * 
 * ## `"name-too-long"`
 * 
 * ## `"no-device"`
 * 
 * ## `"no-entry"`
 * 
 * ## `"no-lock"`
 * 
 * ## `"insufficient-memory"`
 * 
 * ## `"insufficient-space"`
 * 
 * ## `"not-directory"`
 * 
 * ## `"not-empty"`
 * 
 * ## `"not-recoverable"`
 * 
 * ## `"unsupported"`
 * 
 * ## `"no-tty"`
 * 
 * ## `"no-such-device"`
 * 
 * ## `"overflow"`
 * 
 * ## `"not-permitted"`
 * 
 * ## `"pipe"`
 * 
 * ## `"read-only"`
 * 
 * ## `"invalid-seek"`
 * 
 * ## `"text-file-busy"`
 * 
 * ## `"cross-device"`
 */
export type ErrorCode = 'access' | 'would-block' | 'already' | 'bad-descriptor' | 'busy' | 'deadlock' | 'quota' | 'exist' | 'file-too-large' | 'illegal-byte-sequence' | 'in-progress' | 'interrupted' | 'invalid' | 'io' | 'is-directory' | 'loop' | 'too-many-links' | 'message-size' | 'name-too-long' | 'no-device' | 'no-entry' | 'no-lock' | 'insufficient-memory' | 'insufficient-space' | 'not-directory' | 'not-empty' | 'not-recoverable' | 'unsupported' | 'no-tty' | 'no-such-device' | 'overflow' | 'not-permitted' | 'pipe' | 'read-only' | 'invalid-seek' | 'text-file-busy' | 'cross-device';
export type Error = import('./wasi-io-streams.js').Error;
export interface DescriptorFlags {
  read?: boolean,
  write?: boolean,
  fileIntegritySync?: boolean,
  dataIntegritySync?: boolean,
  requestedWriteSync?: boolean,
  mutateDirectory?: boolean,
}
export type Filesize = bigint;
export interface PathFlags {
  symlinkFollow?: boolean,
}
export type LinkCount = bigint;
export type Datetime = import('./wasi-clocks-wall-clock.js').Datetime;
export interface DescriptorStat {
  type: DescriptorType,
  linkCount: LinkCount,
  size: Filesize,
  dataAccessTimestamp?: Datetime,
  dataModificationTimestamp?: Datetime,
  statusChangeTimestamp?: Datetime,
}
export type NewTimestamp = NewTimestampNoChange | NewTimestampNow | NewTimestampTimestamp;
export interface NewTimestampNoChange {
  tag: 'no-change',
}
export interface NewTimestampNow {
  tag: 'now',
}
export interface NewTimestampTimestamp {
  tag: 'timestamp',
  val: Datetime,
}
export interface OpenFlags {
  create?: boolean,
  directory?: boolean,
  exclusive?: boolean,
  truncate?: boolean,
}
export type InputStream = import('./wasi-io-streams.js').InputStream;
export type OutputStream = import('./wasi-io-streams.js').OutputStream;
export interface MetadataHashValue {
  lower: bigint,
  upper: bigint,
}

export class Descriptor {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  readViaStream(offset: Filesize): InputStream;
  writeViaStream(offset: Filesize): OutputStream;
  appendViaStream(): OutputStream;
  getFlags(): DescriptorFlags;
  getType(): DescriptorType;
  setSize(size: Filesize): void;
  read(length: Filesize, offset: Filesize): [Uint8Array, boolean];
  write(buffer: Uint8Array, offset: Filesize): Filesize;
  readDirectory(): DirectoryEntryStream;
  sync(): void;
  createDirectoryAt(path: string): void;
  stat(): DescriptorStat;
  statAt(pathFlags: PathFlags, path: string): DescriptorStat;
  setTimesAt(pathFlags: PathFlags, path: string, dataAccessTimestamp: NewTimestamp, dataModificationTimestamp: NewTimestamp): void;
  openAt(pathFlags: PathFlags, path: string, openFlags: OpenFlags, flags: DescriptorFlags): Descriptor;
  readlinkAt(path: string): string;
  removeDirectoryAt(path: string): void;
  renameAt(oldPath: string, newDescriptor: Descriptor, newPath: string): void;
  symlinkAt(oldPath: string, newPath: string): void;
  unlinkFileAt(path: string): void;
  metadataHash(): MetadataHashValue;
  metadataHashAt(pathFlags: PathFlags, path: string): MetadataHashValue;
}

export class DirectoryEntryStream {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  readDirectoryEntry(): DirectoryEntry | undefined;
}
