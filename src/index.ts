import {
	Bot,
	Context,
	InlineKeyboard,
	InputFile,
	webhookCallback,
} from 'grammy';
import attachChat from './attach-chat';
import BotContext from './bot-context';
import { OrderEntity } from './db/types';
import OpenAI from 'openai';
import { env } from 'cloudflare:workers';

const bot = new Bot<BotContext>(env.BOT_TOKEN);

bot.use(async (ctx, next) => {
	console.info(`Received message: ${JSON.stringify(ctx)}`);
	return next();
});

bot.use(attachChat);

bot.command('start', async (ctx: Context) => {
	await ctx.reply(
		'Hello, friend! 😄 Send me a selfie and I’ll turn it into a cartoon in your favorite style 🎨📸 Just pick the vibe you like! ✨'
	);
});

bot.on('message:photo', async (ctx) => {
	const file = await ctx.getFile();

	if (!file.file_path) {
		console.error('Failed to receive photo. File path is empty: ', file);
		return ctx.reply('Failed to receive photo. Please, try again later');
	}

	const response = await fetch(
		`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`
	);
	if (!response.ok) {
		console.error('Failed to receive photo. Response is not ok: ', response);
		return ctx.reply('Failed to receive photo. Please, try again later');
	}

	const filepath = `${ctx.chatID}/${file.file_path.split('/').pop()}`;

	await env.BUCKET.put(filepath, await response.arrayBuffer());

	const savedOrder = await env.DB.prepare(
		'insert into orders (chat_id, input_image_path) values (?, ?) returning *'
	)
		.bind(ctx.chatID, filepath)
		.run();

	console.info(`New order from ${ctx.chatId}: ${savedOrder.results[0]}`);

	const orderId = savedOrder.results[0].id;

	const keyboard = new InlineKeyboard();
	keyboard.text('Pixar', `pixar:${orderId}`);
	keyboard.text('Anime', `anime:${orderId}`);
	keyboard.row();
	keyboard.text('Ghibli', `ghibli:${orderId}`);
	keyboard.text('Disney', `disney:${orderId}`);
	keyboard.row();

	return ctx.reply('Please, choose style to transform your photo', {
		reply_markup: keyboard,
	});
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
			return ctx.answerCallbackQuery('Order not found');
		}

		return ctx.replyWithInvoice(
			'One-time payment',
			`One-time payment for the photo transformation`,
			JSON.stringify({ orderId }),
			'XTR',
			[{ amount: 1, label: 'XTR' }]
		);
	} catch (err) {
		console.error('Error in callback query: ', err);
		return ctx.answerCallbackQuery(
			'Something went wrong. Please, try again later'
		);
	}
});

bot.on('pre_checkout_query', (ctx) => {
	console.info('Received pre checkout query');
	return ctx.answerPreCheckoutQuery(true).catch((err) => {
		console.error('Error in pre_checkout_query: ', err);
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
		return ctx.reply('Order not found');
	}

	console.info(
		`Sending order to queue: ${JSON.stringify(orderFromDB.results[0])}`
	);

	await env.IMAGE_GEN_Q.send({ order: orderFromDB.results[0] });

	return ctx.reply(
		`✨ I'm now processing your photo in *${orderFromDB.results[0].style}* style. It may take a few minutes. ⏳ Please wait for the magic to happen... 🎨`,
		{ parse_mode: 'Markdown' }
	);
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

				await bot.api.sendPhoto(order.chat_id, new InputFile(imageBytes), {
					caption: `Your photo has been transformed to *${order.style}* style. Thank you for using our service! 🎉`,
					parse_mode: 'Markdown',
				});

				console.info(`Processed order ${order.id} in ${order.style} style`);

				await env.DB.prepare('update orders set status = ? where id = ?')
					.bind('sent', order.id)
					.run();
			} catch (error) {
				console.error(`Failed to process order ${order.id}: ${error}`);
			}
		}
	},
} satisfies ExportedHandler<Env>;
