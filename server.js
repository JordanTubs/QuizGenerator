require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;
const GEMINI_PLACEHOLDER = "your_actual_api_key_here";

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

function hasGeminiKey() {
  return Boolean(
    process.env.GEMINI_API_KEY &&
      process.env.GEMINI_API_KEY.trim() &&
      process.env.GEMINI_API_KEY.trim() !== GEMINI_PLACEHOLDER
  );
}

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
You are an expert NBME/USMLE Step 1 question writer and medical educator.

Read the uploaded source material carefully, identify its high-yield mechanisms and relationships, then generate exactly ${numQuestions} multiple-choice questions based only on that source material.

Requirements:
- Questions must feel like real USMLE Step 1/NBME items, not flashcards.
- Use clinical vignettes, experimental setups, lab findings, physiologic changes, pathology descriptions, or mechanism-based prompts when supported by the PDF.
- Test understanding and application: cause/effect, mechanism, next physiologic change, expected lab finding, pathway consequence, lesion localization, drug effect, or disease mechanism.
- Do not ask questions that can be answered by matching one obvious keyword from the prompt to the answer choice.
- Do not copy one sentence and ask "which concept is supported"; transform the PDF content into a reasoning question.
- Do not make the correct answer longer, more specific, or more detailed than the distractors.
- Distractors must be medically plausible and drawn from nearby or related concepts in the PDF whenever possible.
- All four answer choices should be parallel in grammar, length, and category.
- Avoid giveaway words such as "always", "never", "only", "all of the above", and "none of the above".
- Avoid answer choices that are obviously unrelated to the vignette.
- Each question must have exactly 4 answer choices.
- The "answer" value must be the zero-based index of the correct option.
- Explanations must teach the underlying mechanism and clearly explain why the correct option is right and why each distractor is wrong.
- If the PDF is about non-medical material, still write review-style application questions from the PDF, but do not invent facts outside the source.
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

function chunkText(text) {
  const paragraphs = text
    .split(/(?:\n|\r| {2,})+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 160);
  const chunks = [];

  paragraphs.forEach((paragraph) => {
    if (paragraph.length <= 900) {
      chunks.push(paragraph);
      return;
    }

    const sentences = splitSentences(paragraph);
    let current = "";

    sentences.forEach((sentence) => {
      if (`${current} ${sentence}`.trim().length > 900 && current) {
        chunks.push(current);
        current = sentence;
      } else {
        current = `${current} ${sentence}`.trim();
      }
    });

    if (current) {
      chunks.push(current);
    }
  });

  return chunks.length ? chunks : splitSentences(text);
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 80 && sentence.length <= 500);
}

function scoreSentence(sentence, keywords) {
  const lower = sentence.toLowerCase();
  const keywordHits = keywords.filter((keyword) => lower.includes(keyword)).length;
  const mechanismHits = [
    "increase",
    "decrease",
    "because",
    "therefore",
    "causes",
    "leads",
    "results",
    "stimulates",
    "inhibits",
    "transport",
    "membrane",
    "receptor",
    "gradient",
    "pressure",
    "concentration",
    "potential",
    "channel",
    "pump",
    "permeability"
  ].filter((word) => lower.includes(word)).length;

  return keywordHits * 2 + mechanismHits;
}

function getBestTerms(text, limit = 80) {
  return getKeywords(text)
    .filter((keyword) => keyword.length >= 5)
    .slice(0, limit);
}

function getKeywords(text) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "because",
    "before",
    "between",
    "during",
    "from",
    "have",
    "into",
    "more",
    "most",
    "other",
    "such",
    "than",
    "that",
    "their",
    "then",
    "there",
    "these",
    "this",
    "through",
    "when",
    "where",
    "which",
    "while",
    "with",
    "within",
    "without"
  ]);
  const counts = new Map();
  const words = text.toLowerCase().match(/\b[a-z][a-z-]{4,}\b/g) || [];

  words.forEach((word) => {
    if (!stopWords.has(word)) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  });

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 200);
}

function shuffleWithAnswer(options, correctAnswer, seed) {
  const ordered = options.map((option, index) => ({ option, index }));

  for (let i = ordered.length - 1; i > 0; i -= 1) {
    const swapIndex = (seed + i * 7) % (i + 1);
    [ordered[i], ordered[swapIndex]] = [ordered[swapIndex], ordered[i]];
  }

  return {
    options: ordered.map((item) => item.option),
    answer: ordered.findIndex((item) => item.option === correctAnswer)
  };
}

function titleCase(value) {
  return value
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function makeFallbackQuiz(documentText, numQuestions) {
  const chunks = chunkText(documentText);
  const keywords = getBestTerms(documentText);
  const source = chunks
    .map((chunk) => {
      const sentences = splitSentences(chunk);
      const bestSentence = sentences.length
        ? sentences.sort((a, b) => scoreSentence(b, keywords) - scoreSentence(a, keywords))[0]
        : chunk;
      const chunkTerms = getBestTerms(chunk, 12);
      const keyword = chunkTerms[0] || keywords[0] || "concept";

      return {
        chunk,
        sentence: bestSentence,
        keyword,
        distractors: [...chunkTerms, ...keywords].filter((term) => term !== keyword)
      };
    })
    .filter((item) => item.sentence && item.keyword);

  if (!source.length) {
    throw new Error("No readable study content could be turned into quiz questions.");
  }

  return Array.from({ length: Math.min(numQuestions, source.length) }, (_unused, index) => {
    const item = source[index % source.length];
    const correct = titleCase(item.keyword);
    const distractors = item.distractors
      .filter((keyword) => keyword !== item.keyword)
      .slice(index * 2, index * 2 + 16)
      .map(titleCase);
    const uniqueOptions = [...new Set([correct, ...distractors])].slice(0, 4);

    while (uniqueOptions.length < 4) {
      uniqueOptions.push(
        ["Compensatory Response", "Membrane Permeability", "Physiologic Gradient", "Cellular Transport"][
          uniqueOptions.length - 1
        ]
      );
    }

    const shuffled = shuffleWithAnswer(uniqueOptions, correct, index + 3);

    return {
      q: `A student is reviewing the uploaded PDF and focuses on this passage:\n\n"${item.sentence}"\n\nWhich term best completes the main concept being tested in this passage?`,
      options: shuffled.options,
      answer: shuffled.answer,
      explanation: `${correct} is the best-supported answer from this passage. In basic mode, the quiz uses extracted PDF text and nearby document terms to create review questions. For full USMLE-style reasoning questions with stronger distractors and deeper explanations, add a valid Gemini API key in Render.`
    };
  });
}

app.post("/api/generate-quiz", upload.single("pdf"), async (req, res) => {
  try {
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

    if (!hasGeminiKey()) {
      return res.json({
        questions: makeFallbackQuiz(documentText, numQuestions),
        source: "fallback"
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
      questions: questions.slice(0, numQuestions),
      source: "gemini"
    });
  } catch (error) {
    console.error(error);

    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        error: error.message
      });
    }

    try {
      if (req.file) {
        const numQuestions = parseQuestionCount(req.body.numQuestions);
        const parsedPdf = await pdfParse(req.file.buffer);
        const documentText = (parsedPdf.text || "").replace(/\s+/g, " ").trim();

        if (documentText) {
          return res.json({
            questions: makeFallbackQuiz(documentText, numQuestions),
            source: "fallback"
          });
        }
      }
    } catch (fallbackError) {
      console.error(fallbackError);
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
