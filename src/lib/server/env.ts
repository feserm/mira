import { env } from '$env/dynamic/private';
import { building } from '$app/environment';
import { formatEnvErrors, validateEnv } from './env-schema';

export type { ServerConfig } from './env-schema';

const { config: validated, errors } = validateEnv(env);

// `vite build` imports server modules for analysis with no runtime env present, so only enforce
// at real server start. hooks.server.ts imports this module, so a bad config fails at boot.
if (errors.length > 0 && !building) throw new Error(formatEnvErrors(errors));

export const config = validated;
