/** Role names stored in `user.role` (better-auth admin plugin). Kept apart from `auth-options.ts`
 *  so the guard and its tests do not pull in the database and the validated environment. */
export const ADMIN_ROLE = 'admin';
export const USER_ROLE = 'user';
