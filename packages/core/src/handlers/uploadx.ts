import * as http from 'http';
import * as url from 'url';
import { BaseStorage, DiskStorageOptions, File, FileInit } from '../storages';
import { ERRORS, fail, getBaseUrl, getHeader, getMetadata } from '../utils';
import { BaseHandler } from './base-handler';

export function rangeParser(rangeHeader = ''): { start: number; total: number } {
  const parts = rangeHeader.split(/\s+|\//);
  const total = parseInt(parts[2]);
  const start = parseInt(parts[1]);
  return { start, total };
}

/**
 * X-headers protocol implementation
 */
export class Uploadx<TFile extends Readonly<File>, TList> extends BaseHandler<TFile, TList> {
  static RESUME_STATUS_CODE = 308;

  /**
   * Create File from request and send file url to client
   */
  async post(req: http.IncomingMessage, res: http.ServerResponse): Promise<TFile> {
    const metadata = await getMetadata(req, this.storage.maxMetadataSize).catch(error =>
      fail(ERRORS.BAD_REQUEST, error)
    );
    const config: FileInit = { metadata };
    config.userId = this.getUserId(req, res);
    config.size = getHeader(req, 'x-upload-content-length');
    config.contentType = getHeader(req, 'x-upload-content-type');
    const file = await this.storage.create(req, config);
    const statusCode = file.bytesWritten > 0 ? 200 : 201;
    const headers = { Location: this.buildFileUrl(req, file) };
    this.send(res, { statusCode, headers });
    return file;
  }

  async patch(req: http.IncomingMessage, res: http.ServerResponse): Promise<TFile> {
    const name = this.getName(req);
    if (!name) return fail(ERRORS.FILE_NOT_FOUND);
    const metadata = await getMetadata(req, this.storage.maxMetadataSize).catch(error =>
      fail(ERRORS.BAD_REQUEST, error)
    );
    const file = await this.storage.update(name, { metadata, name });
    this.send(res, { body: file.metadata });
    return file;
  }

  /**
   * Write chunk to file or/and return chunk offset
   */
  async put(req: http.IncomingMessage, res: http.ServerResponse): Promise<TFile> {
    const name = this.getName(req);
    if (!name) return fail(ERRORS.FILE_NOT_FOUND);
    const contentRange = getHeader(req, 'content-range');
    const contentLength = +getHeader(req, 'content-length');
    const { start } = contentRange ? rangeParser(contentRange) : { start: 0 };
    const file = await this.storage.write({ start, name, contentLength, body: req });
    if (file.status === 'part') {
      const headers = { Range: `bytes=0-${file.bytesWritten - 1}` };
      res.statusMessage = 'Resume Incomplete';
      this.send(res, { statusCode: Uploadx.RESUME_STATUS_CODE, headers });
    }
    return file;
  }

  /**
   * Delete upload by id
   */
  async delete(req: http.IncomingMessage, res: http.ServerResponse): Promise<TFile> {
    const name = this.getName(req);
    if (!name) return fail(ERRORS.FILE_NOT_FOUND);
    const [file] = await this.storage.delete(name);
    this.send(res, { statusCode: 204 });
    return file;
  }

  getName(req: http.IncomingMessage): string {
    const { query } = url.parse(decodeURI(req.url || ''), true);
    if (query.name) return query.name as string;
    if (query.upload_id) return query.upload_id as string;
    return super.getName(req);
  }

  /**
   * Build file url from request
   */
  protected buildFileUrl(
    req: http.IncomingMessage & { originalUrl?: string },
    file: File & { GCSUploadURI?: string }
  ): string {
    if (file.GCSUploadURI) return file.GCSUploadURI;

    const { query, pathname } = url.parse(req.originalUrl || (req.url as string), true);
    query.upload_id = file.name;
    const path = url.format({ pathname, query });
    const baseUrl = this.storage.config.useRelativeLocation ? '' : getBaseUrl(req);
    return `${baseUrl}${path}`;
  }
}

/**
 * Basic express wrapper
 * @example
 * app.use('/files', uploadx({directory: '/tmp', maxUploadSize: '250GB'}));
 */
export function uploadx<TFile extends Readonly<File>, TList>(
  options: DiskStorageOptions | { storage: BaseStorage<TFile, TList> } = {}
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return new Uploadx(options).handle;
}

/**
 * Express wrapper
 *
 * - express ***should*** respond to the client when the upload is complete and handle errors and GET requests
 * @example
 * app.use('/files', uploadx.upload({ storage }), (req, res, next) => {
  if (req.method === 'GET') {
    return res.sendStatus(404);
  }
  console.log('File upload complete: ', req.body.name);
  return res.json(req.body);
});
 */
uploadx.upload = <TFile extends Readonly<File>, TList>(
  options: DiskStorageOptions | { storage: BaseStorage<TFile, TList> }
) => new Uploadx(options).upload;
