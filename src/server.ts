/// <reference types="bun-types" />
import {
  AppBskyNotificationListNotifications,
  BskyAgent,
  RichText,
} from "@atproto/api";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import OpenAI from "openai";

// Types
type Comment = {
  id: string;
  originalPostUri: string;
  originalPostCid: string;
  commentUri: string;
  commentCid: string;
  author: string;
  text: string;
  embedding: string; // JSON stringified array
  createdAt: string;
  processed: boolean;
};

type NotificationView = AppBskyNotificationListNotifications.Notification;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: Bun.env.OPENAI_API_KEY,
});

// Initialize Bluesky agent
const agent = new BskyAgent({
  service: "https://bsky.social",
});

// Initialize SQLite database
const db = new Database("bluesky_comments.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    originalPostUri TEXT NOT NULL,
    originalPostCid TEXT NOT NULL,
    commentUri TEXT NOT NULL,
    commentCid TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS community_notes (
    id TEXT PRIMARY KEY,
    originalPostUri TEXT NOT NULL,
    originalPostCid TEXT NOT NULL,
    noteText TEXT NOT NULL,
    commentIds TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    posted BOOLEAN NOT NULL DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS processed_posts (
    uri TEXT PRIMARY KEY,
    cid TEXT NOT NULL,
    processedAt TEXT NOT NULL,
    noteCount INTEGER NOT NULL DEFAULT 0
  );
`);

// Initialize Hono app
const app = new Hono();

// Configuration
const BLUESKY_IDENTIFIER = Bun.env.BLUESKY_IDENTIFIER;
const BLUESKY_PASSWORD = Bun.env.BLUESKY_PASSWORD;
const CHECK_INTERVAL_MS = 1 * 60 * 1000; // 1 minute
const SIMILARITY_THRESHOLD = 0.2; // Lowered from 0.75 to 0.2
const MIN_COMMENTS_FOR_NOTE = 3; // Minimum number of comments to generate a note

if (!BLUESKY_IDENTIFIER || !BLUESKY_PASSWORD) {
  throw new Error("BLUESKY_IDENTIFIER and BLUESKY_PASSWORD must be set");
}

// Login to Bluesky
const loginToBluesky = async (): Promise<boolean> => {
  try {
    await agent.login({
      identifier: BLUESKY_IDENTIFIER,
      password: BLUESKY_PASSWORD,
    });
    console.log("Logged in to Bluesky successfully");
    return true;
  } catch (error) {
    console.error("Failed to login to Bluesky:", error);
    return false;
  }
};

// Get embedding from OpenAI
const getEmbedding = async (text: string): Promise<number[]> => {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
      encoding_format: "float",
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error("Error getting embedding:", error);
    return [];
  }
};

// Calculate cosine similarity between two vectors
const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// Save comment to database
const saveComment = async (comment: Comment): Promise<void> => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO comments (
      id, originalPostUri, originalPostCid, commentUri, commentCid, 
      author, text, embedding, createdAt, processed
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    comment.id,
    comment.originalPostUri,
    comment.originalPostCid,
    comment.commentUri,
    comment.commentCid,
    comment.author,
    comment.text,
    comment.embedding,
    comment.createdAt,
    comment.processed ? 1 : 0
  );
};

// Save community note to database
const saveCommunityNote = (
  id: string,
  originalPostUri: string,
  originalPostCid: string,
  noteText: string,
  commentIds: string[]
): void => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO community_notes (
      id, originalPostUri, originalPostCid, noteText, commentIds, createdAt, posted
    )
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `);

  stmt.run(
    id,
    originalPostUri,
    originalPostCid,
    noteText,
    JSON.stringify(commentIds),
    new Date().toISOString()
  );
};

// Mark community note as posted
const markCommunityNoteAsPosted = (id: string): void => {
  const stmt = db.prepare("UPDATE community_notes SET posted = 1 WHERE id = ?");
  stmt.run(id);
};

// Delete community notes for a post
const deleteCommunityNotesForPost = (originalPostUri: string): void => {
  const stmt = db.prepare("DELETE FROM community_notes WHERE originalPostUri = ?");
  stmt.run(originalPostUri);
  console.log(`Deleted existing community notes for post ${originalPostUri}`);
};

// Mark comment as processed
const markCommentAsProcessed = (id: string): void => {
  const stmt = db.prepare("UPDATE comments SET processed = 1 WHERE id = ?");
  stmt.run(id);
};

// Mark post as processed
const markPostAsProcessed = (uri: string, cid: string, noteCount: number): void => {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO processed_posts (uri, cid, processedAt, noteCount)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(uri, cid, new Date().toISOString(), noteCount);
  console.log(`Marked post ${uri} as processed with ${noteCount} notes`);
};

// Check if a post has been processed
const isPostProcessed = (uri: string): boolean => {
  const stmt = db.prepare("SELECT COUNT(*) as count FROM processed_posts WHERE uri = ?");
  const result = stmt.get(uri) as { count: number };
  return result.count > 0;
};

// Get all comments for a post
const getAllCommentsForPost = (originalPostUri: string): Comment[] => {
  const stmt = db.prepare("SELECT * FROM comments WHERE originalPostUri = ?");
  const rows = stmt.all(originalPostUri) as any[];

  return rows.map((row) => ({
    ...row,
    embedding: JSON.parse(row.embedding),
    processed: Boolean(row.processed),
  }));
};

// Generate a community note using OpenAI
const generateCommunityNote = async (comments: Comment[]): Promise<string> => {
  try {
    const commentTexts = comments.map((c) => c.text).join("\n\n");

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful community note generator. Your task is to analyze multiple comments about a post and generate a concise, factual community note that summarizes the key corrections or clarifications. Start with '**COMMUNITY NOTE**' and be objective, clear, and helpful. IMPORTANT: Your response MUST be under 280 characters total to fit within Bluesky's character limit.",
        },
        {
          role: "user",
          content: `Here are several comments about a post. Please generate a community note that summarizes the key corrections or clarifications. Keep it under 280 characters total:\n\n${commentTexts}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
    });

    const noteText = response.choices[0].message.content || 
      "**COMMUNITY NOTE** Unable to generate note.";
    
    // Ensure the note is within Bluesky's character limit
    if (noteText.length > 280) {
      return noteText.substring(0, 277) + "...";
    }
    
    return noteText;
  } catch (error) {
    console.error("Error generating community note:", error);
    return "**COMMUNITY NOTE** Unable to generate note due to an error.";
  }
};

// Post a reply to the original post
const postReply = async (
  text: string,
  replyToUri: string,
  replyToCid: string
): Promise<boolean> => {
  try {
    // Check if text exceeds Bluesky's character limit (300 characters)
    let postText = text;
    if (text.length > 280) {
      console.warn(`Text exceeds Bluesky's character limit. Truncating from ${text.length} to 280 characters.`);
      postText = text.substring(0, 277) + "...";
    }

    // Create a RichText object to properly format the text
    const rt = new RichText({ text: postText });
    await rt.detectFacets(agent);

    const result = await agent.post({
      text: rt.text,
      facets: rt.facets,
      reply: {
        root: {
          uri: replyToUri,
          cid: replyToCid,
        },
        parent: {
          uri: replyToUri,
          cid: replyToCid,
        },
      },
      createdAt: new Date().toISOString(),
    });

    console.log(`Posted community note as reply: ${result.uri}`);
    return true;
  } catch (error) {
    console.error("Failed to post reply:", error);
    return false;
  }
};

// Find similar comments and generate community notes
const processSimilarComments = async (): Promise<void> => {
  try {
    // Get all unique original post URIs with at least MIN_COMMENTS_FOR_NOTE comments
    const postUrisStmt = db.prepare(`
      SELECT originalPostUri, originalPostCid, COUNT(*) as commentCount 
      FROM comments 
      GROUP BY originalPostUri 
      HAVING commentCount >= ?
    `);
    
    const postUris = postUrisStmt.all(MIN_COMMENTS_FOR_NOTE) as { 
      originalPostUri: string, 
      originalPostCid: string,
      commentCount: number 
    }[];
    
    console.log(`Found ${postUris.length} posts with at least ${MIN_COMMENTS_FOR_NOTE} comments`);
    
    for (const { originalPostUri, originalPostCid, commentCount } of postUris) {
      console.log(`Processing post ${originalPostUri} with ${commentCount} comments`);
      
      // Check if we've already posted a note to this post
      const hasExistingNote = await hasExistingNoteForPost(originalPostUri);
      
      if (hasExistingNote) {
        console.log(`Skipping post ${originalPostUri} - already has a community note`);
        
        // Mark the post as processed if it's not already
        if (!isPostProcessed(originalPostUri)) {
          markPostAsProcessed(originalPostUri, originalPostCid, 1);
        }
        
        continue;
      }
      
      // Delete any existing community notes for this post from our database
      deleteCommunityNotesForPost(originalPostUri);
      
      const comments = getAllCommentsForPost(originalPostUri);
      console.log(`Retrieved ${comments.length} comments for post ${originalPostUri}`);
      
      // Find clusters of similar comments
      const similarCommentGroups: Comment[][] = [];
      const processedIndices = new Set<number>();
      
      for (let i = 0; i < comments.length; i++) {
        if (processedIndices.has(i)) continue;
        
        const currentGroup: Comment[] = [comments[i]];
        processedIndices.add(i);
        
        console.log(`Starting new group with comment ${comments[i].id} by ${comments[i].author}`);
        
        for (let j = i + 1; j < comments.length; j++) {
          if (processedIndices.has(j)) continue;
          
          const similarity = cosineSimilarity(
            comments[i].embedding as unknown as number[], 
            comments[j].embedding as unknown as number[]
          );
          
          console.log(`Similarity between comment ${comments[i].id} and ${comments[j].id}: ${similarity.toFixed(4)} (threshold: ${SIMILARITY_THRESHOLD})`);
          
          if (similarity >= SIMILARITY_THRESHOLD) {
            console.log(`Adding comment ${comments[j].id} to group (similarity: ${similarity.toFixed(4)})`);
            currentGroup.push(comments[j]);
            processedIndices.add(j);
          }
        }
        
        console.log(`Group size: ${currentGroup.length}, minimum required: ${MIN_COMMENTS_FOR_NOTE}`);
        
        if (currentGroup.length >= MIN_COMMENTS_FOR_NOTE) {
          console.log(`Found group of ${currentGroup.length} similar comments, adding to candidates for note generation`);
          similarCommentGroups.push(currentGroup);
        }
      }
      
      console.log(`Found ${similarCommentGroups.length} groups of similar comments for post ${originalPostUri}`);
      
      // Generate and post community notes for each group of similar comments
      let successfulNotes = 0;
      
      for (const group of similarCommentGroups) {
        console.log(`Generating community note for group of ${group.length} comments`);
        console.log(`Comment texts in group: ${group.map(c => `"${c.text}"`).join(' | ')}`);
        
        const noteText = await generateCommunityNote(group);
        console.log(`Generated note: "${noteText}"`);
        
        const commentIds = group.map(c => c.id);
        
        // Save the community note
        const noteId = `note-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        saveCommunityNote(
          noteId,
          originalPostUri,
          originalPostCid,
          noteText,
          commentIds
        );
        console.log(`Saved community note with ID: ${noteId}`);
        
        // Post the community note as a reply
        console.log(`Attempting to post community note as reply to ${originalPostUri}`);
        const posted = await postReply(noteText, originalPostUri, originalPostCid);
        
        if (posted) {
          successfulNotes++;
          console.log(`Successfully posted community note as reply`);
          // Mark the community note as posted
          markCommunityNoteAsPosted(noteId);
          
          // Mark all comments in the group as processed
          for (const comment of group) {
            markCommentAsProcessed(comment.id);
            console.log(`Marked comment ${comment.id} as processed`);
          }
        } else {
          console.log(`Failed to post community note as reply`);
        }
      }
      
      // Mark the post as processed if we successfully posted at least one note
      if (successfulNotes > 0) {
        markPostAsProcessed(originalPostUri, originalPostCid, successfulNotes);
      }
    }
  } catch (error) {
    console.error('Error processing similar comments:', error);
  }
};

// Extract the original post URI from a reply
const extractOriginalPostUri = async (
  replyUri: string
): Promise<{ uri: string; cid: string } | null> => {
  try {
    const threadResponse = await agent.getPostThread({ uri: replyUri });
    const thread = threadResponse.data.thread;

    // Use type assertion and optional chaining to safely navigate the thread structure
    const threadAny = thread as any;

    // If this is a reply, try to find the root post
    if (threadAny?.parent?.post) {
      // If there's a parent.parent, this is a reply to a reply
      if (threadAny.parent.parent) {
        // Navigate up to the root
        let current = threadAny.parent;
        while (current?.parent) {
          current = current.parent;
        }

        if (current?.post?.uri && current?.post?.cid) {
          return {
            uri: current.post.uri,
            cid: current.post.cid,
          };
        }
      } else {
        // This is a direct reply to a post
        return {
          uri: threadAny.parent.post.uri,
          cid: threadAny.parent.post.cid,
        };
      }
    }

    return null;
  } catch (error) {
    console.error("Error extracting original post URI:", error);
    return null;
  }
};

// Extract text after the mention
const extractTextAfterMention = (text: string, handle: string): string => {
  // Find the mention in the text
  const mentionIndex = text.toLowerCase().indexOf(`@${handle.toLowerCase()}`);

  if (mentionIndex === -1) {
    return text; // Return the full text if mention not found
  }

  // Extract text after the mention
  const textAfterMention = text
    .substring(mentionIndex + handle.length + 1)
    .trim();
  return textAfterMention;
};

// Check for new mentions
const checkForMentions = async (): Promise<void> => {
  try {
    if (!agent.session) {
      const loggedIn = await loginToBluesky();
      if (!loggedIn) return;
    }

    // Get notifications
    const notifications = await agent.listNotifications({ limit: 50 });

    // Filter for mentions
    const mentions = notifications.data.notifications.filter(
      (notif) => notif.reason === "mention" && !notif.isRead
    );

    console.log(`Found ${mentions.length} new mentions`);

    // Process each mention
    for (const mention of mentions) {
      // Extract text safely with fallback to empty string
      const fullText =
        typeof mention.record?.text === "string" ? mention.record.text : "";

      // Extract the handle from the DID
      const profileResponse = await agent.getProfile({
        actor: agent.session?.did || "",
      });
      const myHandle = profileResponse.data.handle;

      // Extract text after the mention
      const commentText = extractTextAfterMention(fullText, myHandle);

      if (commentText.length === 0) {
        console.log("No text after mention, skipping");
        continue;
      }

      // Check if this is a reply and get the original post
      const originalPost = await extractOriginalPostUri(mention.uri);

      if (!originalPost) {
        console.log("Could not determine original post, skipping");
        continue;
      }

      // Get embedding for the comment text
      const embedding = await getEmbedding(commentText);

      if (embedding.length === 0) {
        console.log("Failed to get embedding, skipping");
        continue;
      }

      // Create and save the comment
      const comment: Comment = {
        id: mention.cid,
        originalPostUri: originalPost.uri,
        originalPostCid: originalPost.cid,
        commentUri: mention.uri,
        commentCid: mention.cid,
        author: mention.author.handle,
        text: commentText,
        embedding: JSON.stringify(embedding),
        createdAt: mention.indexedAt,
        processed: false,
      };

      await saveComment(comment);
      console.log(`Saved comment: ${comment.id}`);
    }

    // Mark notifications as read
    if (mentions.length > 0) {
      await agent.updateSeenNotifications();
    }
  } catch (error) {
    console.error("Error checking for mentions:", error);
  }
};

// Check if we've already posted a note to this post
const hasExistingNoteForPost = async (postUri: string): Promise<boolean> => {
  try {
    if (!agent.session) {
      const loggedIn = await loginToBluesky();
      if (!loggedIn) return false;
    }

    // Get our own DID
    const profileResponse = await agent.getProfile({
      actor: agent.session?.did || "",
    });
    const myDid = profileResponse.data.did;

    // Get the thread for the post
    const threadResponse = await agent.getPostThread({ uri: postUri });
    const thread = threadResponse.data.thread;

    // Check if any of the replies are from us
    const threadAny = thread as any;
    const replies = threadAny?.replies || [];

    for (const reply of replies) {
      if (reply?.post?.author?.did === myDid) {
        // This is a reply from us
        console.log(`Found existing note for post ${postUri}`);
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error(`Error checking for existing note for post ${postUri}:`, error);
    return false;
  }
};

// Routes
app.get("/", (c) => {
  return c.text("Bluesky Community Notes Bot is running");
});

app.get("/status", (c) => {
  const commentsCount = db
    .prepare("SELECT COUNT(*) as count FROM comments")
    .get() as { count: number };
  const processedCount = db
    .prepare("SELECT COUNT(*) as count FROM comments WHERE processed = 1")
    .get() as { count: number };
  const notesCount = db
    .prepare("SELECT COUNT(*) as count FROM community_notes")
    .get() as { count: number };
  const postedCount = db
    .prepare("SELECT COUNT(*) as count FROM community_notes WHERE posted = 1")
    .get() as { count: number };
  const processedPostsCount = db
    .prepare("SELECT COUNT(*) as count FROM processed_posts")
    .get() as { count: number };
    
  // Get posts with at least 3 comments
  const postsWithCommentsStmt = db.prepare(`
    SELECT originalPostUri, COUNT(*) as commentCount 
    FROM comments 
    GROUP BY originalPostUri 
    HAVING commentCount >= ?
  `);
  const postsWithComments = postsWithCommentsStmt.all(MIN_COMMENTS_FOR_NOTE) as { originalPostUri: string, commentCount: number }[];
  
  // Get processed posts
  const processedPostsStmt = db.prepare("SELECT * FROM processed_posts ORDER BY processedAt DESC");
  const processedPosts = processedPostsStmt.all() as { uri: string, cid: string, processedAt: string, noteCount: number }[];

  return c.json({
    status: "running",
    loggedIn: !!agent.session,
    comments: commentsCount.count,
    processedComments: processedCount.count,
    communityNotes: notesCount.count,
    postedNotes: postedCount.count,
    processedPosts: processedPostsCount.count,
    postsWithEnoughComments: postsWithComments.length,
    posts: postsWithComments.map(p => ({
      uri: p.originalPostUri,
      commentCount: p.commentCount,
      processed: processedPosts.some(pp => pp.uri === p.originalPostUri)
    })),
    recentlyProcessedPosts: processedPosts.slice(0, 10).map(p => ({
      uri: p.uri,
      processedAt: p.processedAt,
      noteCount: p.noteCount
    }))
  });
});

app.post("/check-now", async (c) => {
  await checkForMentions();
  return c.json({ success: true, message: "Checked for new mentions" });
});

app.post("/process-similar", async (c) => {
  await processSimilarComments();
  return c.json({ success: true, message: "Processed similar comments" });
});

app.post("/process-post", async (c) => {
  try {
    const body = await c.req.json();
    const { postUri } = body;
    
    if (!postUri) {
      return c.json({ success: false, message: "Missing postUri parameter" }, 400);
    }
    
    // Check if we've already posted a note to this post
    const hasExistingNote = await hasExistingNoteForPost(postUri);
    
    if (hasExistingNote) {
      return c.json({ 
        success: false, 
        message: `Post ${postUri} already has a community note` 
      }, 400);
    }
    
    // Delete any existing community notes for this post from our database
    deleteCommunityNotesForPost(postUri);
    
    // Get comments for this post
    const comments = getAllCommentsForPost(postUri);
    
    if (comments.length < MIN_COMMENTS_FOR_NOTE) {
      return c.json({ 
        success: false, 
        message: `Not enough comments (${comments.length}). Minimum required: ${MIN_COMMENTS_FOR_NOTE}` 
      }, 400);
    }
    
    console.log(`Processing post ${postUri} with ${comments.length} comments`);
    
    // Find clusters of similar comments
    const similarCommentGroups: Comment[][] = [];
    const processedIndices = new Set<number>();
    
    for (let i = 0; i < comments.length; i++) {
      if (processedIndices.has(i)) continue;
      
      const currentGroup: Comment[] = [comments[i]];
      processedIndices.add(i);
      
      console.log(`Starting new group with comment ${comments[i].id} by ${comments[i].author}`);
      
      for (let j = i + 1; j < comments.length; j++) {
        if (processedIndices.has(j)) continue;
        
        const similarity = cosineSimilarity(
          comments[i].embedding as unknown as number[], 
          comments[j].embedding as unknown as number[]
        );
        
        console.log(`Similarity between comment ${comments[i].id} and ${comments[j].id}: ${similarity.toFixed(4)} (threshold: ${SIMILARITY_THRESHOLD})`);
        
        if (similarity >= SIMILARITY_THRESHOLD) {
          console.log(`Adding comment ${comments[j].id} to group (similarity: ${similarity.toFixed(4)})`);
          currentGroup.push(comments[j]);
          processedIndices.add(j);
        }
      }
      
      console.log(`Group size: ${currentGroup.length}, minimum required: ${MIN_COMMENTS_FOR_NOTE}`);
      
      if (currentGroup.length >= MIN_COMMENTS_FOR_NOTE) {
        console.log(`Found group of ${currentGroup.length} similar comments, adding to candidates for note generation`);
        similarCommentGroups.push(currentGroup);
      }
    }
    
    console.log(`Found ${similarCommentGroups.length} groups of similar comments for post ${postUri}`);
    
    if (similarCommentGroups.length === 0) {
      return c.json({ 
        success: false, 
        message: "No groups of similar comments found" 
      }, 400);
    }
    
    // Generate and post community notes for each group of similar comments
    const results = [];
    
    for (const group of similarCommentGroups) {
      console.log(`Generating community note for group of ${group.length} comments`);
      console.log(`Comment texts in group: ${group.map(c => `"${c.text}"`).join(' | ')}`);
      
      const noteText = await generateCommunityNote(group);
      console.log(`Generated note: "${noteText}"`);
      
      const commentIds = group.map(c => c.id);
      
      // Save the community note
      const noteId = `note-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      saveCommunityNote(
        noteId,
        postUri,
        group[0].originalPostCid,
        noteText,
        commentIds
      );
      console.log(`Saved community note with ID: ${noteId}`);
      
      // Post the community note as a reply
      console.log(`Attempting to post community note as reply to ${postUri}`);
      const posted = await postReply(noteText, postUri, group[0].originalPostCid);
      
      results.push({
        noteId,
        posted,
        noteText,
        commentCount: group.length
      });
      
      if (posted) {
        console.log(`Successfully posted community note as reply`);
        // Mark the community note as posted
        markCommunityNoteAsPosted(noteId);
        
        // Mark all comments in the group as processed
        for (const comment of group) {
          markCommentAsProcessed(comment.id);
          console.log(`Marked comment ${comment.id} as processed`);
        }
      } else {
        console.log(`Failed to post community note as reply`);
      }
    }
    
    return c.json({ 
      success: true, 
      message: `Processed post ${postUri}`,
      results
    });
  } catch (error) {
    console.error("Error processing post:", error);
    return c.json({ success: false, message: "Error processing post", error: String(error) }, 500);
  }
});

app.post("/reset-post", async (c) => {
  try {
    const body = await c.req.json();
    const { postUri, force = false } = body;
    
    if (!postUri) {
      return c.json({ success: false, message: "Missing postUri parameter" }, 400);
    }
    
    // Check if we've already posted a note to this post
    if (!force) {
      const hasExistingNote = await hasExistingNoteForPost(postUri);
      
      if (hasExistingNote) {
        return c.json({ 
          success: false, 
          message: `Post ${postUri} already has a community note on Bluesky. Use force=true to override.` 
        }, 400);
      }
    }
    
    // Delete from processed_posts
    const deleteProcessedStmt = db.prepare("DELETE FROM processed_posts WHERE uri = ?");
    deleteProcessedStmt.run(postUri);
    
    // Delete community notes
    deleteCommunityNotesForPost(postUri);
    
    // Reset processed flag for comments
    const resetCommentsStmt = db.prepare("UPDATE comments SET processed = 0 WHERE originalPostUri = ?");
    resetCommentsStmt.run(postUri);
    
    return c.json({ 
      success: true, 
      message: `Reset post ${postUri} for reprocessing${force ? ' (forced)' : ''}`
    });
  } catch (error) {
    console.error("Error resetting post:", error);
    return c.json({ success: false, message: "Error resetting post", error: String(error) }, 500);
  }
});

app.get("/check-post", async (c) => {
  try {
    const postUri = c.req.query("postUri");
    
    if (!postUri) {
      return c.json({ success: false, message: "Missing postUri parameter" }, 400);
    }
    
    // Check if we've already posted a note to this post
    const hasExistingNote = await hasExistingNoteForPost(postUri);
    
    // Check if the post is marked as processed in our database
    const isProcessed = isPostProcessed(postUri);
    
    // Get comments for this post
    const comments = getAllCommentsForPost(postUri);
    
    return c.json({ 
      success: true,
      postUri,
      hasExistingNote,
      isProcessedInDb: isProcessed,
      commentCount: comments.length,
      hasEnoughComments: comments.length >= MIN_COMMENTS_FOR_NOTE
    });
  } catch (error) {
    console.error("Error checking post:", error);
    return c.json({ success: false, message: "Error checking post", error: String(error) }, 500);
  }
});

// Start the server
const port = Bun.env.PORT || 3000;

console.log(`Starting server on port ${port}...`);
console.log(`Bluesky identifier: ${BLUESKY_IDENTIFIER}`);

// Process all comments and mentions
const processAll = async (): Promise<void> => {
  try {
    // First check for new mentions
    await checkForMentions();
    
    // Then process all similar comments
    await processSimilarComments();
  } catch (error) {
    console.error("Error in processAll:", error);
  }
};

// Initial login
loginToBluesky().then(() => {
  // Start periodic checking
  setInterval(processAll, CHECK_INTERVAL_MS);

  // Initial check
  processAll();
});

export default {
  port,
  fetch: app.fetch,
};
