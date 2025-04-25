import type { NextFunction } from 'grammy';

import type BotContext from './bot-context';

export default async function attachChat(ctx: BotContext, next: NextFunction) {
	if (ctx.preCheckoutQuery) {
		return next();
	}

	if (!ctx.chat?.id) {
		return;
	}

	ctx.chatID = ctx.chat.id;

	return next();
}
