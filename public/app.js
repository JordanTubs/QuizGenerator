const quizForm = document.getElementById("quiz-form");
const uploadContainer = document.getElementById("upload-container");
const quizContainer = document.getElementById("quiz-container");
const resultsContainer = document.getElementById("results-container");
const pdfInput = document.getElementById("pdf-input");
const dropzone = document.getElementById("dropzone");
const fileName = document.getElementById("file-name");
const numQuestionsInput = document.getElementById("num-questions");
const generateButton = document.getElementById("generate-button");
const statusMessage = document.getElementById("status-message");
const questionCounter = document.getElementById("question-counter");
const scoreDisplay = document.getElementById("score-display");
const progressBar = document.getElementById("progress-bar");
const questionText = document.getElementById("question-text");
const optionsList = document.getElementById("options-list");
const explanationCard = document.getElementById("explanation-card");
const explanationText = document.getElementById("explanation-text");
const nextButton = document.getElementById("next-button");
const resultsPercentage = document.getElementById("results-percentage");
const resultsFraction = document.getElementById("results-fraction");
const motivationMessage = document.getElementById("motivation-message");
const mistakesReview = document.getElementById("mistakes-review");
const restartButton = document.getElementById("restart-button");

let questions = [];
let currentQuestionIndex = 0;
let score = 0;
let answeredCurrentQuestion = false;
let selectedPdfFile = null;
let userAnswers = [];

function isPdfFile(file) {
  return Boolean(
    file &&
      (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
  );
}

function setSelectedFile(file) {
  selectedPdfFile = file;
  fileName.textContent = file?.name || "or choose a file to upload";
  statusMessage.textContent = file ? "" : statusMessage.textContent;
  dropzone.classList.toggle("has-file", Boolean(file));
}

function getMotivation(percentage) {
  if (percentage >= 90) {
    return "Outstanding work. You are building the kind of recall and reasoning that holds up under pressure.";
  }

  if (percentage >= 75) {
    return "Strong performance. Review the misses, tighten the weak spots, and you are moving in the right direction.";
  }

  if (percentage >= 50) {
    return "Good reps. Every missed question is a map of what to review next.";
  }

  return "Keep going. The goal is progress, not perfection, and today's mistakes can become tomorrow's easy points.";
}

function renderMistakes() {
  const missedQuestions = questions
    .map((question, index) => ({
      ...question,
      questionNumber: index + 1,
      selectedAnswer: userAnswers[index]
    }))
    .filter((question) => question.selectedAnswer !== question.answer);

  mistakesReview.innerHTML = "";

  const title = document.createElement("h3");
  title.textContent = missedQuestions.length ? "Review Your Mistakes" : "No Mistakes to Review";
  mistakesReview.appendChild(title);

  if (!missedQuestions.length) {
    const perfectMessage = document.createElement("p");
    perfectMessage.className = "review-empty";
    perfectMessage.textContent = "Perfect score. Keep this PDF handy and come back later for spaced repetition.";
    mistakesReview.appendChild(perfectMessage);
    return;
  }

  missedQuestions.forEach((question) => {
    const selectedLabel =
      question.selectedAnswer === null || question.selectedAnswer === undefined
        ? "No answer selected"
        : `${String.fromCharCode(65 + question.selectedAnswer)}. ${
            question.options[question.selectedAnswer]
          }`;
    const correctLabel = `${String.fromCharCode(65 + question.answer)}. ${
      question.options[question.answer]
    }`;

    const card = document.createElement("article");
    card.className = "mistake-card";
    card.innerHTML = `
      <p class="mistake-number">Question ${question.questionNumber}</p>
      <p class="mistake-question"></p>
      <div class="answer-comparison">
        <p><strong>Your answer:</strong> <span class="incorrect-text"></span></p>
        <p><strong>Correct answer:</strong> <span class="correct-text"></span></p>
      </div>
      <p class="mistake-explanation"></p>
    `;

    card.querySelector(".mistake-question").textContent = question.q;
    card.querySelector(".incorrect-text").textContent = selectedLabel;
    card.querySelector(".correct-text").textContent = correctLabel;
    card.querySelector(".mistake-explanation").textContent = question.explanation;
    mistakesReview.appendChild(card);
  });
}

function setLoading(isLoading) {
  generateButton.disabled = isLoading;
  generateButton.classList.toggle("is-loading", isLoading);
  statusMessage.textContent = isLoading
    ? "Reading the PDF and building your quiz..."
    : "";
}

function showView(view) {
  uploadContainer.classList.toggle("hidden", view !== "upload");
  quizContainer.classList.toggle("hidden", view !== "quiz");
  resultsContainer.classList.toggle("hidden", view !== "results");
}

function updateProgress() {
  const total = questions.length;
  const answered = currentQuestionIndex + (answeredCurrentQuestion ? 1 : 0);
  const percentage = total ? (answered / total) * 100 : 0;

  scoreDisplay.textContent = `Score: ${score} / ${total}`;
  questionCounter.textContent = `Question ${currentQuestionIndex + 1} of ${total}`;
  progressBar.style.width = `${percentage}%`;
}

function renderQuestion() {
  const question = questions[currentQuestionIndex];

  answeredCurrentQuestion = false;
  questionText.textContent = question.q;
  optionsList.innerHTML = "";
  explanationText.textContent = "";
  explanationCard.classList.add("hidden");
  nextButton.classList.add("hidden");
  nextButton.textContent =
    currentQuestionIndex === questions.length - 1 ? "See Results" : "Next Question";

  question.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-button";
    button.innerHTML = `<span>${String.fromCharCode(65 + index)}</span>${option}`;
    button.addEventListener("click", () => selectOption(index));
    optionsList.appendChild(button);
  });

  updateProgress();
}

function selectOption(selectedIndex) {
  if (answeredCurrentQuestion) {
    return;
  }

  const question = questions[currentQuestionIndex];
  const optionButtons = [...optionsList.querySelectorAll(".option-button")];
  const isCorrect = selectedIndex === question.answer;

  answeredCurrentQuestion = true;

  if (isCorrect) {
    score += 1;
  }

  userAnswers[currentQuestionIndex] = selectedIndex;

  optionButtons.forEach((button, index) => {
    button.disabled = true;

    if (index === question.answer) {
      button.classList.add("correct");
    } else if (index === selectedIndex) {
      button.classList.add("incorrect");
    }
  });

  explanationText.textContent = question.explanation;
  explanationCard.classList.remove("hidden");
  nextButton.classList.remove("hidden");
  updateProgress();
}

function showResults() {
  const total = questions.length;
  const percentage = total ? Math.round((score / total) * 100) : 0;

  resultsPercentage.textContent = `${percentage}%`;
  resultsFraction.textContent = `${score} / ${total} correct`;
  motivationMessage.textContent = getMotivation(percentage);
  renderMistakes();
  showView("results");
}

async function generateQuiz(event) {
  event.preventDefault();

  const file = selectedPdfFile || pdfInput.files[0];
  const requestedCount = Number.parseInt(numQuestionsInput.value, 10);
  const count = Math.min(Math.max(Number.isNaN(requestedCount) ? 10 : requestedCount, 1), 60);

  if (!file) {
    statusMessage.textContent = "Choose a PDF before generating a quiz.";
    return;
  }

  const formData = new FormData();
  formData.append("pdf", file);
  formData.append("numQuestions", String(count));

  setLoading(true);

  try {
    const response = await fetch("/api/generate-quiz", {
      method: "POST",
      body: formData
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Quiz generation failed.");
    }

    questions = payload.questions || [];

    if (!questions.length) {
      throw new Error("No questions were returned.");
    }

    currentQuestionIndex = 0;
    score = 0;
    userAnswers = Array(questions.length).fill(null);
    if (payload.source === "fallback") {
      statusMessage.textContent =
        "Basic PDF mode was used. Add a valid Gemini API key in Render for smarter USMLE-style reasoning questions.";
    }
    showView("quiz");
    renderQuestion();
  } catch (error) {
    statusMessage.textContent = `${error.message} Try a text-based PDF or a smaller file.`;
  } finally {
    setLoading(false);
  }
}

function handleNextQuestion() {
  if (currentQuestionIndex >= questions.length - 1) {
    showResults();
    return;
  }

  currentQuestionIndex += 1;
  renderQuestion();
}

function resetQuiz() {
  questions = [];
  currentQuestionIndex = 0;
  score = 0;
  answeredCurrentQuestion = false;
  quizForm.reset();
  selectedPdfFile = null;
  userAnswers = [];
  fileName.textContent = "or click this box to choose a PDF";
  statusMessage.textContent = "Upload a reviewer PDF and the site will build a quiz from it.";
  progressBar.style.width = "0%";
  motivationMessage.textContent = "";
  mistakesReview.innerHTML = "";
  showView("upload");
}

pdfInput.addEventListener("change", () => {
  const file = pdfInput.files[0];

  if (!file) {
    setSelectedFile(null);
    return;
  }

  if (!isPdfFile(file)) {
    setSelectedFile(null);
    statusMessage.textContent = "Only PDF files are supported.";
    pdfInput.value = "";
    return;
  }

  setSelectedFile(file);
});

["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
  });
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
});

dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];

  if (!file) {
    return;
  }

  if (!isPdfFile(file)) {
    statusMessage.textContent = "Only PDF files are supported.";
    return;
  }

  setSelectedFile(file);
});

quizForm.addEventListener("submit", generateQuiz);
nextButton.addEventListener("click", handleNextQuestion);
restartButton.addEventListener("click", resetQuiz);
