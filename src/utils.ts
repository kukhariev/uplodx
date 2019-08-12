import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { promisify } from 'util';

export const fsMkdir = promisify(fs.mkdir);
export const fsClose = promisify(fs.close);
export const fsOpen = promisify(fs.open);
export const fsStat = promisify(fs.stat);
export const fsUnlink = promisify(fs.unlink);

export function isObject(val: any): boolean {
  return !!val && val.constructor === Object;
}
export async function ensureDir(dir: string): Promise<void> {
  dir = path.normalize(dir);
  const paths = dir.split(path.sep);
  path.isAbsolute(dir) && paths.shift();
  let parent = path.parse(dir).root;
  for (const p of paths) {
    parent = path.join(parent, p);
    try {
      await fsMkdir(parent);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
}
/**
 * Return md5 checksum
 */
export function hashObject(data: any): string {
  let ordered = {} as any;
  if (isObject(data)) {
    Object.keys(data)
      .sort()
      .forEach(key => {
        ordered[key] = data[key];
      });
  } else {
    ordered = data;
  }
  return createHash('md5')
    .update(JSON.stringify(ordered))
    .digest('hex');
}

/**
 * Ensures that the file exists.
 */
export async function ensureFile(filePath: string, overwrite = false): Promise<number> {
  await ensureDir(path.dirname(filePath));
  await fsClose(await fsOpen(filePath, overwrite ? 'w' : 'a'));
  const { size } = await fsStat(filePath);
  return size;
}

export async function getFileSize(filePath: string): Promise<number> {
  const fileStat = await fsStat(filePath);
  return fileStat.size;
}

/**
 * Parse the JSON body of an request
 */
export function getBody<T extends http.IncomingMessage>(req: T): Promise<unknown> {
  return new Promise(resolve => {
    if ('body' in req) {
      resolve((req as any).body);
    } else {
      const buffer: Buffer[] = [];
      req.on('data', chunk => buffer.push(chunk));
      req.on('end', () => resolve(Buffer.concat(buffer)));
    }
  });
}
export function typeis(req: http.IncomingMessage, types: string[]): string | false {
  const contentType = req.headers['content-type'] || '';
  return typeis.is(contentType, types);
}
typeis.is = function(mime: string, types: string[] = ['/']): string | false {
  const mimeRegExp = new RegExp(types.map(str => str.replace(/\*/g, '')).join('|'));
  return mime.search(mimeRegExp) !== -1 ? mime : false;
};
typeis.hasBody = function(req: http.IncomingMessage): number | false {
  const bodySize = Number(req.headers['content-length']);
  return !isNaN(bodySize) && bodySize;
};
