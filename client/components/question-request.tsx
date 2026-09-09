import { useState } from "react";

import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { api, type QuestionRequest as QuestionRequestValue } from "../lib/api.js";
import { shapeQuestionAnswers } from "../lib/questions.js";

export function QuestionRequest({
  directory,
  sessionID,
  request,
  onResolved,
}: {
  directory: string;
  sessionID: string;
  request: QuestionRequestValue;
  onResolved: () => void;
}) {
  const [selected, setSelected] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const { answers, valid } = shapeQuestionAnswers(request.questions, selected, custom);

  const submit = async () => {
    if (!valid) {
      setError("Answer every question before submitting.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await api.replyQuestion(directory, sessionID, request.id, answers);
      onResolved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const reject = async () => {
    setSubmitting(true);
    setError("");
    try {
      await api.rejectQuestion(directory, sessionID, request.id);
      onResolved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-h-[40dvh] shrink-0 overflow-y-auto overscroll-contain px-4 pt-3" data-testid="opencode-question-request">
      <Alert variant="warning">
        <div className="space-y-4">
          {request.questions.map((question, questionIndex) => (
            <fieldset key={questionIndex} className="min-w-0">
              <legend className="mb-2 text-sm font-semibold">{question.header}</legend>
              <p className="mb-2 text-sm">{question.question}</p>
              <div className="space-y-2">
                {question.options.map((option) => {
                  const checked = selected[questionIndex]?.includes(option.label) ?? false;
                  return (
                    <label key={option.label} className="flex min-h-11 cursor-pointer items-start gap-3 rounded border border-[var(--color-border-default)] p-2">
                      <input
                        type={question.multiple ? "checkbox" : "radio"}
                        name={`${request.id}-${questionIndex}`}
                        value={option.label}
                        checked={checked}
                        onChange={() => {
                          setSelected((current) => current.map((answer, index) => index !== questionIndex
                            ? answer
                            : question.multiple
                              ? checked ? answer.filter((value) => value !== option.label) : [...answer, option.label]
                              : [option.label]));
                          if (!question.multiple) setCustom((current) => current.map((value, index) => index === questionIndex ? "" : value));
                        }}
                        className="mt-1 h-4 w-4 shrink-0"
                        data-testid="opencode-question-option"
                      />
                      <span className="min-w-0 text-sm"><strong>{option.label}</strong>{option.description ? <span className="block text-xs text-[var(--color-text-muted)]">{option.description}</span> : null}</span>
                    </label>
                  );
                })}
                {question.custom !== false && (
                  <label className="block text-sm">
                    Custom answer
                    <input
                      value={custom[questionIndex] ?? ""}
                      onChange={(event) => {
                        setCustom((current) => current.map((value, index) => index === questionIndex ? event.target.value : value));
                        if (!question.multiple && event.target.value) setSelected((current) => current.map((value, index) => index === questionIndex ? [] : value));
                      }}
                      className="mt-1 min-h-11 w-full rounded border border-[var(--color-border-default)] bg-transparent px-3 text-base"
                      data-testid="opencode-question-custom"
                    />
                  </label>
                )}
              </div>
            </fieldset>
          ))}
          {error && <p className="text-sm" role="alert">{error}</p>}
          <div className="sticky bottom-0 -mx-3 -mb-3 rounded-b-lg bg-[var(--color-background-surface-warning-muted)] px-3 pb-3 pt-2">
            <div className="flex flex-wrap justify-end gap-2">
              <Button className="min-h-11" variant="danger" disabled={submitting} onClick={() => void reject()} data-testid="opencode-question-reject">Reject</Button>
              <Button className="min-h-11" disabled={submitting || !valid} onClick={() => void submit()} data-testid="opencode-question-submit">Submit answers</Button>
            </div>
          </div>
        </div>
      </Alert>
    </div>
  );
}
