import fastify from 'fastify';
import { Uploadx } from '../src';
import { join } from 'path';

const server = fastify({ logger: true });
const uploadx = new Uploadx({ directory: 'files' });
uploadx.on('completed', ({ name, originalName }) =>
  server.log.info(
    `upload complete, path: ${join('files', name)}, original filename: ${originalName}`
  )
);

// eslint-disable-next-line promise/catch-or-return
server.register(require('fastify-express')).then(
  () => {
    server.use('/files', uploadx.handle);
    return server.listen(3003, (err, address) => {
      if (err) throw err;
      server.log.info(`server listening on ${address}`);
    });
  },
  e => console.error(e)
);
