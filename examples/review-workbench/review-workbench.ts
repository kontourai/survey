import {
  browserReviewWorkbenchStartState,
  mountReviewWorkbench,
} from "../../src/review-workbench/review-workbench.js";

const root = document.querySelector<HTMLElement>("#review-workbench");
if (!root) {
  throw new Error("Missing #review-workbench root.");
}

mountReviewWorkbench(root, browserReviewWorkbenchStartState());
