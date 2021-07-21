import * as http from 'http';
import { extname, join, relative, resolve as pathResolve } from 'path';
import { ensureFile, ERRORS, fail, fsp, getFiles, getWriteStream, HttpError } from '../utils';
import {
  File,
  FileInit,
  FilePart,
  hasContent,
  isValidPart,
  updateMetadata,
  isCompleted
} from './file';
import { BaseStorage, BaseStorageOptions, METAFILE_EXTNAME } from './storage';

const INVALID_OFFSET = -1;

export class DiskFile extends File {}

export interface DiskListObject {
  name: string;
}

export type DiskStorageOptions = BaseStorageOptions<DiskFile> & {
  /**
   * Uploads directory
   * @defaultValue './files'
   */
  directory?: string;
};

/**
 * Local Disk Storage
 */
export class DiskStorage extends BaseStorage<DiskFile, DiskListObject> {
  directory: string;

  constructor(public config: DiskStorageOptions = {}) {
    super(config);
    this.directory = config.directory || this.path.replace(/^\//, '');
    this.isReady = true;
    this.maxFilenameLength = 255 - pathResolve(this.directory, METAFILE_EXTNAME).length;
  }

  normalizeError(error: Error & { code?: string }): HttpError {
    if (error.code) {
      return {
        message: error.message,
        code: error.code,
        statusCode: 500,
        name: error.name
      };
    }
    return super.normalizeError(error);
  }

  /**
   * Add file to storage
   */
  async create(req: http.IncomingMessage, fileInit: FileInit): Promise<DiskFile> {
    const file = new DiskFile(fileInit);
    file.name = this.namingFunction(file);
    await this.validate(file);
    await this._saveMeta(file);
    file.status = 'created';
    return file;
  }

  /**
   * Write chunks
   */
  async write(part: FilePart): Promise<DiskFile> {
    const file = await this._getMeta(part.name);
    if (file.status === 'completed' || file.lockedBy) return file;
    if (!isValidPart(part, file)) return fail(ERRORS.FILE_CONFLICT);
    try {
      this.lock(file.name, part.contentLength);
      file.bytesWritten = await this._write({ ...file, ...part });
      if (file.bytesWritten === INVALID_OFFSET) return fail(ERRORS.FILE_CONFLICT);
      if (isCompleted(file)) {
        await this._saveMeta(file);
      }
      return file;
    } catch (err) {
      return fail(ERRORS.FILE_ERROR, err);
    } finally {
      this.unlock(file.name);
    }
  }

  async get(prefix = ''): Promise<DiskListObject[]> {
    const files = await getFiles(join(this.directory, prefix));
    const props = (path: string): DiskListObject => ({
      name: relative(this.directory, path).replace(/\\/g, '/')
    });
    return files.filter(name => extname(name) !== METAFILE_EXTNAME).map(path => props(path));
  }

  async delete(name: string): Promise<DiskFile[]> {
    const file = await this._getMeta(name).catch(() => null);
    if (file) {
      await fsp.unlink(this._getPath(name)).catch(() => null);
      await this._deleteMeta(name);
      return [{ ...file, status: 'deleted' }];
    }
    return [{ name } as DiskFile];
  }

  async update(name: string, { metadata }: Partial<File>): Promise<DiskFile> {
    const file = await this._getMeta(name);
    updateMetadata(file, metadata);
    await this._saveMeta(file);
    return { ...file, status: 'updated' };
  }

  protected _write(part: FilePart & File): Promise<number> {
    return new Promise((resolve, reject) => {
      const path = this._getPath(part.name);
      if (hasContent(part)) {
        const file = getWriteStream(path, part.start);
        file.once('error', error => reject(error));
        const body = part.body;
        body.once('aborted', () => {
          file.close();
          return resolve(NaN);
        });
        let start = part.start;
        body.on('data', (chunk: { length: number }) => {
          start += chunk.length;
          if (start > part.size) {
            file.close();
            return resolve(INVALID_OFFSET);
          }
        });
        body.pipe(file).on('finish', () => resolve(part.start + file.bytesWritten));
      } else {
        resolve(ensureFile(path));
      }
    });
  }

  protected async _saveMeta(file: DiskFile): Promise<DiskFile> {
    const path = this._getPath(file.name);
    file.bytesWritten = await ensureFile(path).catch(e => fail(ERRORS.FILE_ERROR, e));
    await fsp.writeFile(this._getMetaPath(file.name), JSON.stringify(file, null, 2));
    this.cache.set(file.name, file);
    return file;
  }

  protected async _deleteMeta(name: string): Promise<void> {
    this.cache.delete(name);
    await fsp.unlink(this._getMetaPath(name));
    return;
  }

  protected async _getMeta(name: string): Promise<DiskFile> {
    let file = this.cache.get(name);
    if (file) return file;
    try {
      const json = await fsp.readFile(this._getMetaPath(name), { encoding: 'utf8' });
      file = JSON.parse(json) as DiskFile;
      this.cache.set(name, file);
      return file;
    } catch {}
    return fail(ERRORS.FILE_NOT_FOUND);
  }

  protected _getPath(name: string): string {
    return pathResolve(this.directory, name);
  }

  protected _getMetaPath(name: string): string {
    return this._getPath(name) + METAFILE_EXTNAME;
  }
}
