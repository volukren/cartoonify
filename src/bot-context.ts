import { Context as BaseContext } from 'grammy';

export default interface BotContext extends BaseContext {
	chatID: number;
}
