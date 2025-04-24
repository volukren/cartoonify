export interface OrderEntity {
	id: number;
	created_at: string;
	chat_id: number;
	input_image_path: string;
	output_image_path: string | null;
	style: string | null;
	status: string;
	error: string | null;
}
