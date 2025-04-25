export interface OrderEntity {
	id: number;
	created_at: string;
	chat_id: number;
	input_image_path: string;
	output_image_path: string | null;
	style: string | null;
	status: string;
	error: string | null;
	telegram_payment_charge_id: string | null;
}

export interface ChatEntity {
	id: number;
	username: string | null;
	first_name: string | null;
	last_name: string | null;
	language_code: string | null;
	type: string | null;
}
