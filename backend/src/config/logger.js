import pino from 'pino';
import { env, isProduction } from './env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  transport: isProduction
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } },
  base: undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'password_hash',
      '*.password_hash',
      'refreshToken',
      '*.refreshToken',
      'push_secret',
      '*.push_secret',
    ],
    censor: '[redacted]',
  },
});

export default logger;
