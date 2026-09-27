<script setup lang="ts">
import { computed } from 'vue'

// Renders the little markdown the AI uses (paragraphs, "- " lists, **bold**) without v-html
const props = defineProps<{ text: string }>()

type Span = { text: string; bold: boolean }
type Block = { kind: 'p'; lines: Span[][] } | { kind: 'ul'; items: Span[][] }

function spans(line: string): Span[] {
  return line
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false },
    )
}

const blocks = computed<Block[]>(() => {
  const result: Block[] = []
  for (const chunk of props.text.trim().split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((l) => l.trim())
    if (lines.length === 0) continue
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      result.push({ kind: 'ul', items: lines.map((l) => spans(l.replace(/^\s*[-*•]\s+/, ''))) })
    } else {
      result.push({ kind: 'p', lines: lines.map(spans) })
    }
  }
  return result
})
</script>

<template>
  <div class="flex flex-col gap-2">
    <template v-for="(block, b) in blocks" :key="b">
      <ul v-if="block.kind === 'ul'" class="list-disc space-y-1 pl-5">
        <li v-for="(item, i) in block.items" :key="i">
          <template v-for="(span, s) in item" :key="s">
            <strong v-if="span.bold" class="font-semibold">{{ span.text }}</strong>
            <template v-else>{{ span.text }}</template>
          </template>
        </li>
      </ul>
      <p v-else>
        <template v-for="(line, l) in block.lines" :key="l">
          <br v-if="l > 0" />
          <template v-for="(span, s) in line" :key="s">
            <strong v-if="span.bold" class="font-semibold">{{ span.text }}</strong>
            <template v-else>{{ span.text }}</template>
          </template>
        </template>
      </p>
    </template>
  </div>
</template>
