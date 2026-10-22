# sagents-translate

A chapter-by-chapter literary translation tool with a persistent glossary, editorial history, and resumable stages.

## Status

Project bootstrap. This repository records the initial design; the translation commands are not implemented yet.

## Architecture

The translator is a separate application. Its first model adapter will use the documented JSON interface of [`sagents ask`](https://github.com/jointsome0-lgtm/sagents/blob/main/docs/ask.md). sagents owns sign-in, token renewal, provider connections, and transport errors. The translator owns the book and the translation workflow.

Keep the adapter isolated so another model backend can be added without changing the book format. Record the supported sagents version and validate request and response shapes.

## Workflow

1. Prepare the chapter and its relevant glossary, story state, and character knowledge.
2. Draft the translation.
3. Compare it with the original for omissions, additions, numbers, terminology, and meaning.
4. Edit the target-language prose, then recheck substantive changes.
5. Save a new revision and proposed updates to the shared glossary and story notes.
6. Review consistency across a block of chapters and revisit affected earlier passages when new evidence warrants it.

Read ahead for context without introducing later revelations into earlier narration. Keep source problems and uncertain interpretations in an editorial issue log.

Each saved stage should identify its source, model, workflow version, and glossary revision. Resume from completed stages after a failure; preserve accepted translations when producing a revision. Stop on exhausted provider budgets.

Choose output settings according to the model and provider. There is no universal 2048-token ceiling: translate a whole chapter when the input, context, and expected output fit, and split at meaningful boundaries when necessary.

## Initial milestones

- Implement the sagents adapter with synthetic fixtures and no live calls in tests.
- Define a versioned book format and reliable stage checkpoints.
- Build a single-chapter draft, review, and revision cycle.
- Add glossary proposals, block consistency checks, and export.

Book sources, translations, and run data belong in a local `books/` directory and are excluded from Git by default. Credentials remain outside this repository.
