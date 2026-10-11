// Importing modules
import mongoose from "mongoose";

/*
    One evaluated example from the versioned dataset (src/evals). Platform data, not
    tenant data: examples are synthetic and runs are started by operators.
*/
const modelEvaluationSchema = new mongoose.Schema({

    runId: { type: String, required: true },

    datasetVersion: { type: String, required: true },

    // "code" for deterministic checks, the model name for AI tasks
    modelVersion: { type: String, required: true },

    // short hash of the system prompt actually sent (changes whenever the prompt code changes)
    promptVersion: { type: String, required: true },

    taskType: { type: String, required: true },

    exampleId: { type: String, required: true },

    passed: { type: Boolean, required: true },

    score: Number,

    failureCategory: String,

    detail: String,

    evaluatedAt: { type: Date, default: Date.now },

});

modelEvaluationSchema.index({ runId: 1 });
modelEvaluationSchema.index({ evaluatedAt: -1 });

const ModelEvaluation = mongoose.model("ModelEvaluation", modelEvaluationSchema);

export default ModelEvaluation;
