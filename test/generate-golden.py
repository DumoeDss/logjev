"""Regenerate fixtures from LogJev-py: python test/generate-golden.py <python-repo>."""
import importlib.util
import itertools
import json
import math
from pathlib import Path
import sys

source = Path(sys.argv[1]) / 'logjev/jev.py'
spec = importlib.util.spec_from_file_location('reference_jev', source)
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)
questions = [
    {'type': 'choice', 'instructions': 'Choose a direction.', 'criteria': {'up': 'Move up', 'left': '', 'down': 'Move down', 'right': 'Move right'}},
    {'type': 'choice', 'instructions': 'Choose a Unicode label.', 'criteria': {'日本語': '日本語の説明', '中文': '中文说明', 'emoji': '🚀'}},
    {'type': 'choice', 'instructions': 'Handle boundary options.', 'criteria': {f'option-{i}': str(i) for i in range(48)}},
    {'type': 'score', 'instructions': 'How urgent is it?', 'criteria': ['low', 'normal', 'high', 'critical']},
    {'type': 'score', 'instructions': 'Pick a level.', 'criteria': [False, True, None, 3]},
    {'type': 'noul', 'instructions': 'Is this a refund request?'},
]
contexts = [
    {'state': '  Customer needs a refund.  ', 'history': None},
    {'state': {'ticket': '中文', 'count': 2, 'tags': ['billing', True, None]}, 'history': None},
    {'state': None, 'history': [{'role': 'user', 'content': [{'type': 'text', 'text': 'Choose a move.'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AA=='}}]}]},
    {'state': None, 'history': None},
]
cases = []
for raw, context, mode, firm in itertools.product(questions, contexts, ['minimal', 'full'], [False, True]):
    question = ref.normalize_question('q', raw)
    messages, labels = ref.build_prompt(context['state'], question, context['history'], mode, firm)
    tops = [{labels[0]: -0.2, labels[-1]: -2.1, '!': -5}, {'unrelated': -0.5}, {}, {label: -1000 - i / 3 for i, label in enumerate(labels)}]
    cases.append({'raw': raw, **context, 'mode': mode, 'firm': firm, 'messages': messages, 'labels': labels, 'answers': [{'top': top, 'answer': ref.answer_for(question, labels, top)} for top in tops]})
parse_cases = [
    {'logprobs': {'content': [{'top_logprobs': [{'token': ' A', 'logprob': -.2}, {'token': 'A', 'logprob': -8}, {'token': 'B ', 'logprob': -2}, {'token': 'C', 'logprob': -9999}]}]}},
    {'logprobs': {'content': [{'top_logprobs': {' A': -.3, 'A ': -3, 'B': -1, 'C': -9000}}]}},
    {'logprobs': None}, {'logprobs': {'content': []}}, {'logprobs': {'content': [{'top_logprobs': [{'token': 'A', 'logprob': -9999}]}]}},
]
rounding = []
for raw in [{'type': 'score', 'instructions': 'Rate.', 'criteria': ['low', 'high']}, {'type': 'choice', 'instructions': 'Pick.', 'criteria': {'first': '', 'second': ''}}]:
    question = ref.normalize_question('q', raw)
    _, labels = ref.build_prompt('', question)
    top = {labels[0]: 0, labels[1]: math.log(1 / 63)}
    rounding.append({'raw': raw, 'labels': labels, 'top': top, 'answer': ref.answer_for(question, labels, top)})
data = {'cases': cases, 'rounding': rounding, 'parse': [{'choice': c, 'expected': ref.parse_top_logprobs(c)} for c in parse_cases]}
target = Path(__file__).parent / 'fixtures/golden.json'
target.parent.mkdir(exist_ok=True)
target.write_bytes((json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
print(f'{len(cases)} prompt cases, {sum(len(c["answers"]) for c in cases)} distributions, {len(parse_cases)} parser cases')
