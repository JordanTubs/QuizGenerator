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
const restartButton = document.getElementById("restart-button");

let questions = [];
let currentQuestionIndex = 0;
let score = 0;
let answeredCurrentQuestion = false;

function setLoading(isLoading) {
  generateButton.disabled = isLoading;
  generateButton.classList.toggle("is-loading", isLoading);
  statusMessage.textContent = isLoading
    ? "Reading the PDF and building clinical vignettes..."
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
  showView("results");
}

async function generateQuiz(event) {
  event.preventDefault();

  const file = pdfInput.files[0];
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
    showView("quiz");
    renderQuestion();
  } catch (error) {
    statusMessage.textContent = error.message;
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
  fileName.textContent = "or choose a file to upload";
  statusMessage.textContent = "";
  progressBar.style.width = "0%";
  showView("upload");
}

pdfInput.addEventListener("change", () => {
  fileName.textContent = pdfInput.files[0]?.name || "or choose a file to upload";
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

  if (file.type !== "application/pdf") {
    statusMessage.textContent = "Only PDF files are supported.";
    return;
  }

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  pdfInput.files = dataTransfer.files;
  fileName.textContent = file.name;
  statusMessage.textContent = "";
});

quizForm.addEventListener("submit", generateQuiz);
nextButton.addEventListener("click", handleNextQuestion);
restartButton.addEventListener("click", resetQuiz);
