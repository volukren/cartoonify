import type { NextFunction } from 'grammy';

import type BotContext from './bot-context';

export default async function attachChat(ctx: BotContext, next: NextFunction) {
	if (!ctx.chat?.id) {
		return;
	}

	console.info('chatId: ', ctx.chat.id);

	ctx.chatID = ctx.chat.id;

	return next();
}
