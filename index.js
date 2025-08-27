const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { URL } = require('url');
const fs = require('fs/promises');
const os = require('os');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const PptxParser = require('node-pptx-parser').default;
const JSON5 = require('json5');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = 3001;

// ✅ API Keys
const GEMINI_API_KEY = "AIzaSyCpJ2hRwRULcT9wVOnQ0zgctTJezoWWZdY";
const YOUTUBE_API_KEY =  "AIzaSyBozBKoer2PI00pheCSXU2V8sNOgdT5urM";

if (!GEMINI_API_KEY || !YOUTUBE_API_KEY) {
  console.error("❌ Missing API keys in .env or hardcoded fallback.");
  process.exit(1);
}

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Gemini Setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" });

// ✅ YouTube Helper
async function fetchYouTubeVideo(query) {
  const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&type=video&maxResults=1`;

  const response = await fetch(apiUrl);
  if (!response.ok) {
    console.log(`YouTube API request failed: ${response.statusText}`);
    throw new Error(`YouTube API request failed: ${response.statusText}`);
  }

  const data = await response.json();
  const video = data.items?.[0];
  return video ? `https://www.youtube.com/embed/${video.id.videoId}` : null;
}

// ✅ Main Route
app.post('/analyze-file-url', async (req, res) => {
  const { fileUrl } = req.body;
  if (!fileUrl) return res.status(400).json({ error: 'Missing fileUrl in request body.' });

  let tempFilePath = null;

  try {
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) {
      throw new Error(`Failed to fetch file. Status: ${fileRes.status}`);
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const parsedUrl = new URL(fileUrl);
    const ext = path.extname(parsedUrl.pathname).toLowerCase();

    let fullText = '';

    if (ext === '.pdf') {
      const pdfData = await pdfParse(buffer);
      fullText = pdfData.text;
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      fullText = result.value;
    } else if (ext === '.pptx') {
      const uniqueFilename = `temp_pptx_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.pptx`;
      tempFilePath = path.join(os.tmpdir(), uniqueFilename);
      await fs.writeFile(tempFilePath, buffer);

      try {
        const parser = new PptxParser(tempFilePath);
        const slides = await parser.extractText();

        fullText = slides
          .map(slide => slide.text.join('\n'))
          .join('\n\n')
          .trim();
      } catch (error) {
        return res.status(500).json({ error: 'Failed to parse PPTX file.' });
      }
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Only PDF, DOCX, and PPTX are allowed.' });
    }

    // ✨ Step 1: Get Title from Gemini
    const titlePrompt = `
Given the following course content, generate a short and accurate title for it.
Only respond with the title as a plain string — no extra words or formatting.

Course Content:
${fullText.slice(0, 1500)}
`;

    const titleResponse = await model.generateContent(titlePrompt);
    const lectureTitle = titleResponse.response.text().trim().replace(/["']/g, '');

    console.log('📘 Gemini Lecture Title:', lectureTitle);

    // 🔍 Step 2: Search YouTube
    const lectureVideoUrl = await fetchYouTubeVideo(lectureTitle);

    // 🧠 Step 3: Main Gemini Prompt
    const mainPrompt = `
You're an AI tutor. Analyze the following course content and generate:

1. A well-detailed summary broken into units or subtopics.
2. For each unit, include at most 3 MCQs with 4 options and the correct answer.
3. Only the first and final unit should include this YouTube video to help understand the overall lecture: ${lectureVideoUrl}
4. Strictly generate valid JSON in the format:

[
  {
    "unit": "Unit title",
    "summary": "Short detailed summary of this unit...",
    "youtube": "https://youtube.com/embed/....", // Only in the first and last unit
    "questions": [
      {
        "question": "What is ...?",
        "options": [
          {"value": "A", "text": "Option A"},
          {"value": "B", "text": "Option B"},
          {"value": "C", "text": "Option C"}
        ],
        "answer": "C"
      }
    ]
  }
]

Here is the course content:
${fullText}
`;

    const aiResponse = await model.generateContent(mainPrompt);
    const rawText = aiResponse.response.text().trim().replace(/```json\n?|```/g, '');

    const parsed = JSON5.parse(rawText);
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(500).json({ error: 'Could not process file.', details: err.message });
  } finally {
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch (e) {
        console.warn('⚠️ Failed to delete temp file:', e.message);
      }
    }
  }
});

// ✅ Health Check
app.get('/', (req, res) => res.send('🚀 Smart Study Server is running...on port 3001'));

// ✅ Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
