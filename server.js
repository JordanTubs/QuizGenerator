require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
  fileSize: 20 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      return cb(new Error("Only PDF files are supported."));
    }
    cb(null, true);
  }
});

function parseQuestionCount(value) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return 10;
  }

  return Math.min(Math.max(parsed, 1), 60);
}

function extractJsonArray(text) {
  if (!text || typeof text !== "string") {
    throw new Error("The model returned an empty response.");
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("The model response was not valid JSON.");
    }

    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function validateQuizPayload(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("The model did not return any questions.");
  }

  return payload.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Question ${index + 1} is malformed.`);
    }

    const options = Array.isArray(item.options) ? item.options : [];
    const answer = Number.isInteger(item.answer) ? item.answer : -1;

    if (
      typeof item.q !== "string" ||
      options.length !== 4 ||
      !options.every((option) => typeof option === "string") ||
      answer < 0 ||
      answer > 3 ||
      typeof item.explanation !== "string"
    ) {
      throw new Error(`Question ${index + 1} does not match the required schema.`);
    }

    return {
      q: item.q.trim(),
      options: options.map((option) => option.trim()),
      answer,
      explanation: item.explanation.trim()
    };
  });
}

function buildPrompt(documentText, numQuestions) {
  return `
You are an expert USMLE Step 1 question writer.

Generate exactly ${numQuestions} multiple-choice questions based only on the source material below.

Requirements:
- Questions must be USMLE Step 1 style clinical vignettes that test mechanisms, physiology, pathology, pharmacology, microbiology, biochemistry, anatomy, or immunology when supported by the source.
- Each question must have exactly 4 answer choices.
- The "answer" value must be the zero-based index of the correct option.
- Explanations must include the detailed physiological rationale for the correct option and briefly explain why the other options are wrong.
- Do not include markdown, commentary, code fences, or any keys other than q, options, answer, and explanation.
- Return strict JSON only, matching this exact shape:
[
  {
    "q": "Clinical vignette / question prompt",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": 0,
    "explanation": "Detailed physiological rationale for the correct option and why others are wrong."
  }
]

Source material:
${documentText}
`.trim();
}

app.post("/api/generate-quiz", upload.single("pdf"), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Server configuration error: GEMINI_API_KEY is missing."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Please upload a PDF file."
      });
    }

    const numQuestions = parseQuestionCount(req.body.numQuestions);
    const parsedPdf = await pdfParse(req.file.buffer);
    const documentText = (parsedPdf.text || "").replace(/\s+/g, " ").trim();

    if (!documentText) {
      return res.status(422).json({
        error: "No readable text could be extracted from the PDF."
      });
    }

    const prompt = buildPrompt(documentText.slice(0, 120000), numQuestions);
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.4
      }
    });

    const questions = validateQuizPayload(extractJsonArray(response.text));

    return res.json({
      questions: questions.slice(0, numQuestions)
    });
  } catch (error) {
    console.error(error);

    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        error: error.message
      });
    }

    return res.status(500).json({
      error: error.message || "Failed to generate quiz."
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error) {
    return res.status(400).json({
      error: error.message || "Invalid request."
    });
  }

  return res.status(500).json({
    error: "Unexpected server error."
  });
});

app.listen(port, () => {
  console.log(`USMLE quiz generator running at http://localhost:${port}`);
});
