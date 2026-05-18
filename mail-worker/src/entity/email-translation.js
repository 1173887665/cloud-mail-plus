import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const emailTranslation = sqliteTable('email_translation', {
	emailId: integer('email_id').notNull(),
	targetLang: text('target_lang').notNull(),
	userId: integer('user_id').notNull(),
	translatedSubject: text('translated_subject').notNull(),
	translatedContent: text('translated_content').notNull(),
	sourceLang: text('source_lang'),
	model: text('model').notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => ({
	pk: primaryKey({ columns: [t.emailId, t.targetLang] }),
	userIdx: index('idx_translation_user').on(t.userId),
	emailIdx: index('idx_translation_email').on(t.emailId),
}));

export default emailTranslation;
