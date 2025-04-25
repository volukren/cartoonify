-- Migration number: 0003 	 2025-04-25T11:01:02.839Z

CREATE TABLE chats
(
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    language_code TEXT,
    type TEXT
);