import type { NextFunction } from 'grammy';
import { env } from 'cloudflare:workers';

import type BotContext from './bot-context';
import { ChatEntity } from './db/types';

export default async function attachChat(ctx: BotContext, next: NextFunction) {
	if (ctx.preCheckoutQuery) {
		return next();
	}

	if (!ctx.chat?.id) {
		return;
	}

	ctx.chatID = ctx.chat.id;

	const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?')
		.bind(ctx.chat.id)
		.first<ChatEntity>();

	if (!chat && ctx.from) {
		await env.DB.prepare(
			'insert into chats (id, username, first_name, last_name, language_code, type) values (?, ?, ?, ?, ?, ?)'
		)
			.bind(
				ctx.chat.id,
				ctx.from.username ?? null,
				ctx.from.first_name ?? null,
				ctx.from.last_name ?? null,
				ctx.from.language_code ?? null,
				ctx.chat.type ?? null
			)
			.run();
	}
	return next();
}
