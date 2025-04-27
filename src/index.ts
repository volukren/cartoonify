import { Bot, InlineKeyboard, InputFile, webhookCallback } from 'grammy';
import attachChat from './attach-chat';
import BotContext from './bot-context';
import { OrderEntity } from './db/types';
import OpenAI from 'openai';
import { env } from 'cloudflare:workers';
import {
	ADMIN_CHAT_ID,
	HELLO_MESSAGE_RU,
	HELLO_MESSAGE_EN,
	TRY_LATER_MESSAGE_RU,
	TRY_LATER_MESSAGE_EN,
	CHOOSE_STYLE_MESSAGE_RU,
	CHOOSE_STYLE_MESSAGE_EN,
} from './constants';

const bot = new Bot<BotContext>(env.BOT_TOKEN);

bot.use(async (ctx, next) => {
	console.info(`Received message: ${JSON.stringify(ctx)}`);
	return next();
});

bot.use(attachChat);

bot.command(['start', 'help'], async (ctx) => {
	const photo = await env.BUCKET.get('start.png');
	const message =
		ctx.dbChat.language_code === 'ru' ? HELLO_MESSAGE_RU : HELLO_MESSAGE_EN;
	if (photo) {
		const photoBuffer = Buffer.from(await photo.arrayBuffer());
		return ctx.replyWithPhoto(new InputFile(photoBuffer, 'image.png'), {
			caption: message,
			parse_mode: 'Markdown',
		});
	}
	return ctx.reply(message, { parse_mode: 'Markdown' });
});

bot.on('message:photo', async (ctx) => {
	const file = await ctx.getFile();

	if (!file.file_path) {
		console.error('Failed to receive photo. File path is empty: ', file);
		return ctx.reply(
			ctx.dbChat.language_code === 'ru'
				? TRY_LATER_MESSAGE_RU
				: TRY_LATER_MESSAGE_EN
		);
	}

	const response = await fetch(
		`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`
	);
	if (!response.ok) {
		console.error('Failed to receive photo. Response is not ok: ', response);
		return ctx.reply(
			ctx.dbChat.language_code === 'ru'
				? TRY_LATER_MESSAGE_RU
				: TRY_LATER_MESSAGE_EN
		);
	}

	const filepath = `${ctx.dbChat.id}/${file.file_path.split('/').pop()}`;

	await env.BUCKET.put(filepath, await response.arrayBuffer());

	const savedOrder = await env.DB.prepare(
		'insert into orders (chat_id, input_image_path) values (?, ?) returning *'
	)
		.bind(ctx.dbChat.id, filepath)
		.run();

	console.info(
		`New order from ${ctx.dbChat.id}: ${JSON.stringify(savedOrder.results[0])}`
	);

	const orderId = savedOrder.results[0].id;

	const keyboard = new InlineKeyboard();
	keyboard.text(
		ctx.dbChat.language_code === 'ru' ? 'Пиксар' : 'Pixar',
		`pixar:${orderId}`
	);
	keyboard.text(
		ctx.dbChat.language_code === 'ru' ? 'Аниме' : 'Anime',
		`anime:${orderId}`
	);
	keyboard.row();
	keyboard.text(
		ctx.dbChat.language_code === 'ru' ? 'Гибли' : 'Ghibli',
		`ghibli:${orderId}`
	);
	keyboard.text(
		ctx.dbChat.language_code === 'ru' ? 'Дисней' : 'Disney',
		`disney:${orderId}`
	);
	keyboard.row();

	return ctx.reply(
		ctx.dbChat.language_code === 'ru'
			? CHOOSE_STYLE_MESSAGE_RU
			: CHOOSE_STYLE_MESSAGE_EN,
		{
			reply_markup: keyboard,
		}
	);
});

bot.on('callback_query:data', async (ctx) => {
	try {
		const data = ctx.callbackQuery.data;
		const [style, orderId] = data.split(':');

		const orderFromDB = await env.DB.prepare(
			'update orders set style = ? where id = ? returning *'
		)
			.bind(style, parseInt(orderId))
			.run();

		if (!orderFromDB.success) {
			return ctx.answerCallbackQuery('Заказ не найден');
		}

		return ctx.replyWithInvoice(
			ctx.dbChat.language_code === 'ru'
				? 'Одноразовый платеж'
				: 'One-time payment',
			ctx.dbChat.language_code === 'ru'
				? 'Одноразовый платеж за трансформацию фото'
				: 'One-time payment for photo transformation',
			JSON.stringify({ orderId }),
			'XTR',
			[{ amount: ctx.dbChat.id === ADMIN_CHAT_ID ? 1 : 75, label: 'XTR' }]
		);
	} catch (err) {
		console.error('Error in callback query: ', err);
		return ctx.answerCallbackQuery(
			ctx.dbChat.language_code === 'ru'
				? TRY_LATER_MESSAGE_RU
				: TRY_LATER_MESSAGE_EN
		);
	}
});

bot.on('pre_checkout_query', (ctx) => {
	console.info('Received pre checkout query');
	return ctx.answerPreCheckoutQuery(true).catch((err) => {
		console.error('Error in pre_checkout_query: ', err);
	});
});

bot.command('stats', async (ctx) => {
	if (ctx.dbChat.id !== ADMIN_CHAT_ID) {
		return;
	}

	const stats = await env.DB.prepare(
		'select count(*) as total from orders'
	).run();

	const totalOrders = stats.results[0].total;

	const chatStats = await env.DB.prepare(
		'select count(distinct chat_id) as total from orders'
	).run();

	const totalChats = chatStats.results[0].total;

	return ctx.reply(`Total orders: ${totalOrders}\nTotal chats: ${totalChats}`, {
		parse_mode: 'Markdown',
	});
});

bot.on('message:successful_payment', async (ctx) => {
	console.info(`Received successful payment: ${JSON.stringify(ctx)}`);
	if (!ctx.message || !ctx.message.successful_payment || !ctx.from) {
		return;
	}

	const payment = ctx.message.successful_payment;

	console.info(`payment: ${JSON.stringify(payment)}`);

	const orderId = parseInt(
		(JSON.parse(payment.invoice_payload) as { orderId: string }).orderId
	);

	await env.DB.prepare('update orders set status = ? where id = ?')
		.bind('processing', orderId)
		.run();

	const orderFromDB = await env.DB.prepare('select * from orders where id = ?')
		.bind(orderId)
		.run();

	if (!orderFromDB.success) {
		return ctx.reply(
			ctx.dbChat.language_code === 'ru' ? 'Заказ не найден' : 'Order not found'
		);
	}

	console.info(
		`Sending order to queue: ${JSON.stringify(orderFromDB.results[0])}`
	);

	await env.IMAGE_GEN_Q.send({ order: orderFromDB.results[0] });

	await bot.api.sendMessage(
		ADMIN_CHAT_ID,
		`💰 Новый заказ: ${ctx.from.username ? '@' + ctx.from.username : ''} (${
			ctx.from.first_name ?? ''
		} ${ctx.from.last_name ?? ''}) заказал трансформацию фото в ${
			orderFromDB.results[0].style
		} стиле`
	);

	const message =
		ctx.dbChat.language_code === 'ru'
			? `✨ Обрабатываю фото в *${orderFromDB.results[0].style}* стиле. Это может занять пару минут ⏳`
			: `✨ Processing photo in *${orderFromDB.results[0].style}* style. This may take a few minutes ⏳`;

	return ctx.reply(message, { parse_mode: 'Markdown' });
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return webhookCallback(bot, 'cloudflare-mod')(request);
	},
	async queue(batch, env, ctx) {
		const openai = new OpenAI({
			apiKey: env.OPENAI_API_KEY,
		});
		for (const message of batch.messages) {
			const order = (message.body as { order: OrderEntity }).order;

			try {
				console.info(`Processing order ${JSON.stringify(order)}`);

				await env.DB.prepare('update orders set status = ? where id = ?')
					.bind('processing', order.id)
					.run();

				const image = await env.BUCKET.get(order.input_image_path);
				if (!image) {
					throw new Error('Image not found');
				}

				const response = await openai.images.edit({
					model: 'gpt-image-1',
					image: new File([await image.arrayBuffer()], 'image.jpeg', {
						type: 'image/jpeg',
					}),
					prompt: `Convert this photo to ${order.style} style`,
					n: 1,
					size: '1024x1024',
					quality: 'high',
				});
				if (!response.data || !response.data[0].b64_json) {
					throw new Error('Failed to generate image');
				}

				const imageBase64 = response.data[0].b64_json;
				const imageBytes = Buffer.from(imageBase64, 'base64');

				await env.BUCKET.put(
					`${order.chat_id}/output-${order.id}.jpeg`,
					imageBytes
				);

				await env.DB.prepare(
					'update orders set output_image_path = ?, status = ? where id = ?'
				)
					.bind(
						`${order.chat_id}/output-${order.id}.jpeg`,
						'processed',
						order.id
					)
					.run();

				const chat = await env.DB.prepare('select * from chats where id = ?')
					.bind(order.chat_id)
					.run();

				if (!chat.success || chat.results.length < 1) {
					throw new Error('Chat not found');
				}

				const message =
					chat.results[0].language_code === 'ru'
						? `Фото было трансформировано в *${order.style}*. Спасибо за использование нашего сервиса! 🎉`
						: `Photo was transformed to *${order.style}*. Thank you for using our service! 🎉`;

				await bot.api.sendPhoto(order.chat_id, new InputFile(imageBytes), {
					caption: message,
					parse_mode: 'Markdown',
				});

				console.info(`Processed order ${order.id} in ${order.style} style`);

				await env.DB.prepare('update orders set status = ? where id = ?')
					.bind('sent', order.id)
					.run();
			} catch (error) {
				console.error(`Failed to process order ${order.id}: ${error}`);
				await bot.api.sendMessage(
					ADMIN_CHAT_ID,
					`❌ Ошибка при обработке заказа ${order.id}: ${error}`
				);
			}
		}
	},
} satisfies ExportedHandler<Env>;
