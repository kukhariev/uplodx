import * as bytes from 'bytes';
import * as http from 'http';
import * as url from 'url';
import { BaseHandler, BaseStorage, ERRORS, fail, File, Metadata } from './core';
import { DiskStorage, DiskStorageOptions } from './core/DiskStorage';
import { logger, getHeader, getBaseUrl } from './core/utils';

const log = logger.extend('Tus');

export function serializeMetadata(obj: Metadata): string {
  return Object.entries(obj)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .toString();
}

export function parseMetadata(encoded: string): Metadata {
  const kvPairs = encoded.split(',').map(kv => kv.split(' '));
  const metadata = Object.create(null);
  for (const [key, value] of kvPairs) {
    if (!value || !key) return metadata;
    metadata[key] = Buffer.from(value, 'base64').toString();
  }
  return metadata;
}
/**
 * tus resumable upload protocol
 * @link https://github.com/tus/tus-resumable-upload-protocol/blob/master/protocol.md
 */
export class Tus<T extends BaseStorage> extends BaseHandler {
  idKey = 'upload_id';
  storage: T | DiskStorage;
  constructor(config: { storage: T } | DiskStorageOptions) {
    super();
    this.storage = 'storage' in config ? config.storage : new DiskStorage(config);
    log('options: %o', config);
  }

  async options(req: http.IncomingMessage, res: http.ServerResponse): Promise<File> {
    const headers = {
      'Tus-Extension': 'creation, termination',
      'Tus-Version': '1.0.0',
      'Tus-Resumable': '1.0.0',
      'Tus-Max-Size': bytes.parse(this.storage.config.maxUploadSize || 0)
    };
    res.setHeader('Content-Length', 0);
    res.writeHead(204, headers);
    res.end();
    return Promise.resolve({} as File);
  }

  /**
   * Create File from request and send file url to client
   */
  async post(req: http.IncomingMessage, res: http.ServerResponse): Promise<File> {
    const metadataHeader = getHeader(req, 'upload-metadata');
    const file = new File(parseMetadata(metadataHeader));
    file.userId = this.getUserId(req);
    const length = getHeader(req, 'upload-length');
    file.size = Number.parseInt(length);
    if (Number.isNaN(file.size)) {
      return fail(ERRORS.INVALID_FILE_SIZE);
    }
    file.generateId();
    await this.storage.create(req, file);
    const statusCode = file.bytesWritten > 0 ? 200 : 201;
    const headers = {
      Location: this.buildFileUrl(req, file),
      'Tus-Resumable': '1.0.0'
    };
    this.send({ res, statusCode, headers });
    return file;
  }

  /**
   * Write chunk to file or/and return chunk offset
   */
  async patch(req: http.IncomingMessage, res: http.ServerResponse): Promise<File> {
    const id = this.getFileId(req);
    if (!id) return fail(ERRORS.FILE_NOT_FOUND, 'File id cannot be retrieved');
    const userId = this.getUserId(req);
    const start = Number(getHeader(req, 'upload-offset'));
    const chunk = { start, id, userId };
    const file = await this.storage.write(req, chunk);
    const headers = {
      'Upload-Offset': `${file.bytesWritten}`,
      'Tus-Resumable': '1.0.0'
    };
    this.send({ res, statusCode: 204, headers });
    file.status = file.bytesWritten === file.size ? 'completed' : 'part';
    return file;
  }

  async head(req: http.IncomingMessage, res: http.ServerResponse): Promise<File> {
    const id = this.getFileId(req);
    if (!id) return fail(ERRORS.FILE_NOT_FOUND, 'File id cannot be retrieved');
    const userId = this.getUserId(req);
    const chunk = { start: 0, id, userId };
    const file = await this.storage.write(req, chunk);
    const headers = {
      'Upload-Offset': `${file.bytesWritten}`,
      'Upload-Metadata': serializeMetadata(file.metadata),
      'Tus-Resumable': '1.0.0'
    };
    this.send({ res, headers });
    return file;
  }

  /**
   * Delete upload by id
   */
  async delete(req: http.IncomingMessage, res: http.ServerResponse): Promise<File> {
    const id = this.getFileId(req);
    if (!id) return fail(ERRORS.FILE_NOT_FOUND);
    const userId = this.getUserId(req);
    const [file] = await this.storage.delete({ id, userId });
    const headers = { 'Tus-Resumable': '1.0.0' };
    this.send({ res, statusCode: 204, headers });
    file.status = 'deleted';
    return file;
  }

  async get(req: http.IncomingMessage, res: http.ServerResponse): Promise<File[]> {
    const userId = this.getUserId(req);
    const id = this.getFileId(req);
    const files = await this.storage.get({ id, userId });
    return files;
  }

  /**
   * Get id from request
   */
  protected getFileId(req: http.IncomingMessage): string | undefined {
    const originalUrl = 'originalUrl' in req ? req['originalUrl'] : req.url || '';
    const { pathname = '' } = url.parse(originalUrl, true);
    return pathname.split('/').pop();
  }

  /**
   * Build file url from request
   */
  protected buildFileUrl(req: http.IncomingMessage, file: File): string {
    const originalUrl = 'originalUrl' in req ? req['originalUrl'] : req.url || '';
    const { pathname, query } = url.parse(originalUrl, true);
    const path = url.format({ pathname: `${pathname}/${file.id}`, query });
    const baseUrl = this.storage.config.useRelativeLocation ? '' : getBaseUrl(req);
    return baseUrl ? `${baseUrl}${path}` : `${path}`;
  }
}

/**
 * Basic express wrapper
 */
export function tus(
  options: DiskStorageOptions = {}
): (req: http.IncomingMessage, res: http.ServerResponse, next: Function) => void {
  return new Tus(options).handle;
}
