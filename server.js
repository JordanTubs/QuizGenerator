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
  const key = process.env.GEMINI_API_KEY?.trim() || "";
  return key.startsWith("AIza") && key.length > 20 && key !== GEMINI_PLACEHOLDER;
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
      q: item.q.trim().slice(0, 900),
      options: options.map((option) => option.trim().slice(0, 180)),
      answer,
      explanation: item.explanation.trim().slice(0, 1600)
    };
  });
}

const quizResponseSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description:
          "A short, clear USMLE-style question stem based on the uploaded PDF. Prefer 2-5 sentences."
      },
      options: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: {
          type: "string",
          description:
            "A concise answer choice. All four choices must be parallel in category, grammar, and length."
        }
      },
      answer: {
        type: "integer",
        description: "The zero-based index of the correct answer."
      },
      explanation: {
        type: "string",
        description:
          "A concise teaching explanation that cites the PDF idea and explains why the distractors are wrong."
      }
    },
    required: ["q", "options", "answer", "explanation"]
  }
};

function buildPrompt(documentText, numQuestions) {
  return `
You are an expert NBME/USMLE Step 1 question writer and medical educator.

Read the uploaded source material carefully. Use the PDF as the source for what each question asks. You may use standard medical knowledge and web grounding only to make the wording, mechanism, and distractors medically coherent.

Generate exactly ${numQuestions} multiple-choice questions.

Requirements:
- Keep each displayed question short and easy to read, usually 2-5 sentences.
- Questions must feel like clean USMLE Step 1/NBME-style review items, not copied textbook sentences and not flashcards.
- Base the tested concept on a specific idea from the PDF. Do not ask about a topic absent from the PDF.
- Use clinical vignettes, short experimental setups, lab findings, physiologic changes, pathology descriptions, or mechanism prompts only when they fit the PDF content.
- Test understanding and application: cause/effect, mechanism, expected change, lab finding, pathway consequence, lesion localization, drug effect, or disease mechanism.
- The actual question should be clear, direct, and make sense even if the PDF sentence was messy.
- Do not ask questions that can be answered by matching one obvious keyword from the prompt to the answer choice.
- Do not copy one sentence and ask "which concept is supported"; transform the PDF content into a reasoning question.
- Do not make the correct answer longer, more specific, or more detailed than the distractors.
- Distractors must be medically plausible. Use related PDF concepts first; use standard medical knowledge only to make plausible same-category distractors.
- All four answer choices must be parallel in grammar, length, and category. For example, all mechanisms, all diagnoses, all lab findings, or all physiologic effects.
- Avoid giveaway words such as "always", "never", "only", "all of the above", and "none of the above".
- Avoid answer choices that are obviously unrelated to the vignette.
- Each question must have exactly 4 answer choices.
- The "answer" value must be the zero-based index of the correct option.
- Explanations must be concise, teach the underlying mechanism, mention the PDF idea being tested, and explain why each distractor is wrong.
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

function cleanSentence(sentence, maxLength = 260) {
  const cleaned = sentence
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const shortened = cleaned.slice(0, maxLength);
  return `${shortened.slice(0, shortened.lastIndexOf(" "))}...`;
}

function buildSentenceOptions(item, allSentences, index) {
  const correct = cleanSentence(item.sentence, 170);
  const distractors = allSentences
    .filter((sentence) => sentence !== item.sentence)
    .filter((sentence) => {
      const words = sentence.toLowerCase().match(/\b[a-z][a-z-]{4,}\b/g) || [];
      return words.some((word) => item.distractors.includes(word));
    })
    .map((sentence) => cleanSentence(sentence, 170))
    .filter((sentence) => sentence && sentence !== correct);

  const backupDistractors = [
    "The opposite physiologic response would be expected under these conditions.",
    "The finding is unrelated to the mechanism emphasized in the passage.",
    "The passage supports a different mechanism than this answer choice describes.",
    "This option changes the cause-and-effect relationship described in the PDF."
  ];

  const uniqueOptions = [...new Set([correct, ...distractors, ...backupDistractors])].slice(0, 4);
  return shuffleWithAnswer(uniqueOptions, correct, index + 13);
}

function makeFallbackQuiz(documentText, numQuestions) {
  const chunks = chunkText(documentText);
  const keywords = getBestTerms(documentText);
  const allSentences = splitSentences(documentText)
    .sort((a, b) => scoreSentence(b, keywords) - scoreSentence(a, keywords))
    .slice(0, 120);
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
    const shuffled = buildSentenceOptions(item, allSentences, index);
    const focus = titleCase(item.keyword);

    return {
      q: `The uploaded PDF emphasizes ${focus.toLowerCase()} in the following context:\n\n"${cleanSentence(
        item.chunk,
        420
      )}"\n\nWhich statement is best supported by this part of the PDF?`,
      options: shuffled.options,
      answer: shuffled.answer,
      explanation: `The correct answer is the statement most directly supported by this PDF passage. The other choices use nearby PDF language but do not match the specific cause, mechanism, or relationship emphasized here. For shorter USMLE-style clinical reasoning questions with stronger distractors, add a valid Gemini API key in Render.`
    };
  });
}

async function generateWithGemini(ai, prompt) {
  const baseRequest = {
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: quizResponseSchema,
      temperature: 0.25
    }
  };

  try {
    return await ai.models.generateContent({
      ...baseRequest,
      config: {
        ...baseRequest.config,
        tools: [{ googleSearch: {} }]
      }
    });
  } catch (groundingError) {
    console.warn("Grounded generation failed; retrying without Google Search.", groundingError);
    return ai.models.generateContent(baseRequest);
  }
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
    const response = await generateWithGemini(ai, prompt);

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
