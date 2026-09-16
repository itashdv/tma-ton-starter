import { users, type Db } from '@tma/db'

import type { TelegramUser } from '../auth/init-data'

/** Upserts the Telegram profile; called where a user row must exist or be refreshed. */
export async function upsertUser(db: Db, user: TelegramUser, now: Date): Promise<void> {
  const values = {
    telegramId: BigInt(user.id),
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    languageCode: user.languageCode,
    photoUrl: user.photoUrl,
    isPremium: user.isPremium,
    allowsWriteToPm: user.allowsWriteToPm,
    lastSeenAt: now,
  }
  await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({
      target: users.telegramId,
      set: {
        firstName: values.firstName,
        lastName: values.lastName,
        username: values.username,
        languageCode: values.languageCode,
        photoUrl: values.photoUrl,
        isPremium: values.isPremium,
        allowsWriteToPm: values.allowsWriteToPm,
        lastSeenAt: values.lastSeenAt,
      },
    })
}
