# Bluesky Community Notes Bot

A Bun server built with Hono that automatically generates community notes for Bluesky posts based on user comments.

## Features

- Monitors your Bluesky notifications for mentions in comments
- Extracts the text after the mention as feedback on the original post
- Calculates embeddings for each comment using OpenAI
- Identifies similar comments using cosine similarity
- Generates community notes when multiple similar comments are detected
- Posts community notes as replies to the original posts
- Stores all data in a SQLite database

## Prerequisites

- [Bun](https://bun.sh/) installed on your system
- A Bluesky account
- An OpenAI API key

## Installation

1. Clone this repository
2. Install dependencies:

```bash
bun install
```

## Configuration

Create a `.env` file in the root directory with the following variables:

```
BLUESKY_IDENTIFIER=your-bluesky-handle.bsky.social
BLUESKY_PASSWORD=your-bluesky-password
OPENAI_API_KEY=your-openai-api-key
PORT=3000 # Optional, defaults to 3000
```

The `BLUESKY_IDENTIFIER` should be your full Bluesky handle including the domain (e.g., `username.bsky.social`) or your email address if you use that to log in.

## Usage

Start the server:

```bash
bun start
```

The server will automatically:

- Login to your Bluesky account
- Check for new mentions every 5 minutes
- Extract the text after the mention as feedback on the original post
- Calculate embeddings for each comment using OpenAI
- Identify similar comments using cosine similarity
- Generate community notes when at least 3 similar comments are detected
- Post community notes as replies to the original posts
- Store all data in a SQLite database

## How It Works

1. **Comment Collection**: When users tag your account in a comment on a post, the bot extracts the text after the mention and saves it as feedback on the original post.

2. **Embedding Calculation**: The bot uses OpenAI's embedding model to convert each comment into a vector representation.

3. **Similarity Detection**: When at least 3 comments are collected for a post, the bot calculates the cosine similarity between their embeddings to identify similar comments.

4. **Community Note Generation**: If similar comments are found, the bot uses OpenAI to generate a community note that summarizes the key corrections or clarifications.

5. **Note Posting**: The bot posts the community note as a reply to the original post.

Example:

- Original post: "Grass is blue"
- Comment 1: "@your-handle no this is wrong grass is green"
- Comment 2: "@your-handle he's wrong grass can be green or brown"
- Comment 3: "@your-handle what is this. grass is green"

Generated community note: "**COMMUNITY NOTE** Grass is not normally blue unless maybe it has been painted. Grass is normally green but can be brown if dehydrated."

## API Endpoints

- `GET /`: Check if the server is running
- `GET /status`: Get statistics about collected comments and generated notes
- `POST /check-now`: Manually trigger a check for new mentions
- `POST /process-similar`: Manually trigger processing of similar comments

## Database

The server uses a SQLite database (`bluesky_comments.sqlite`) with two tables:

### Comments Table

- `id`: Unique identifier for the comment
- `originalPostUri`: URI of the original post
- `originalPostCid`: Content ID of the original post
- `commentUri`: URI of the comment
- `commentCid`: Content ID of the comment
- `author`: Handle of the comment author
- `text`: Content of the comment (text after the mention)
- `embedding`: Vector representation of the comment text
- `createdAt`: When the comment was created
- `processed`: Whether the comment has been processed

### Community Notes Table

- `id`: Unique identifier for the note
- `originalPostUri`: URI of the original post
- `originalPostCid`: Content ID of the original post
- `noteText`: Content of the community note
- `commentIds`: IDs of the comments used to generate the note
- `createdAt`: When the note was created
- `posted`: Whether the note has been posted

## License

MIT
