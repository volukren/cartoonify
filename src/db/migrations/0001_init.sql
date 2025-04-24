-- Migration number: 0001 	 2025-04-24T16:23:41.885Z

CREATE TABLE orders
(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    chat_id INTEGER NOT NULL,
    input_image_path TEXT NOT NULL,
    output_image_path TEXT,
    style TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded',
    error TEXT
);