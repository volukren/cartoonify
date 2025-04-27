import { Context as BaseContext } from 'grammy';
import { ChatEntity } from './db/types';

export default interface BotContext extends BaseContext {
	dbChat: ChatEntity;
}
