"""Audit locale dictionaries and visible operator template copy."""

import ast
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest


STATIC = Path(__file__).resolve().parents[1] / "static"
STRING = r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\""
TRANSLATED_FIELDS = {
    "data-text": "agent", "data-aria-text": "agent",
    "data-barcode-text": "barcode",
    "data-weigh-text": "weigh", "data-weigh-aria": "weigh", "data-weigh-placeholder": "weigh",
}


def dictionary(source, name):
    return source.split("  const " + name + " = {\n", 1)[1].split("\n  };", 1)[0]


class TemplateAudit(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.references = []
        self.hardcoded = []
        self.autonym = None

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        self.autonym = {"ko": "한국어", "zh": "中文"}.get(attrs.get("data-lang")) if tag == "button" else None
        for field, catalog in TRANSLATED_FIELDS.items():
            if field in attrs:
                self.references.append((catalog, attrs[field], self.getpos()[0]))
        for attribute in ("aria-label", "title", "alt", "placeholder"):
            if attrs.get(attribute):
                self.hardcoded.append((self.getpos()[0], attribute, attrs[attribute]))

    def handle_endtag(self, _tag):
        self.autonym = None

    def handle_data(self, data):
        # Autonyms identify both language choices. Em dashes represent empty data cells.
        if data.strip() and data.strip() not in (self.autonym, "—"):
            self.hardcoded.append((self.getpos()[0], "text", data.strip()))


class TranslatedScreenTests(unittest.TestCase):
    def catalog_keys(self, name):
        source = (STATIC / (name + ".js")).read_text(encoding="utf-8")
        if name == "weigh":
            return self.paired_keys(dictionary(source, "translations"))
        blocks = dict(re.findall(r"^    (ko|zh): \{\n(.*?)\n    \},", dictionary(source, "words"),
                                 re.DOTALL | re.MULTILINE))
        self.assertEqual(set(blocks), {"ko", "zh"})
        keys_by_locale = {}
        for lang, body in blocks.items():
            keys = re.findall(r"\b(\w+)\s*:", re.sub(STRING, "", body))
            self.assertEqual(len(keys), len(set(keys)), (name, lang))
            keys_by_locale[lang] = set(keys)
        self.assertSetEqual(keys_by_locale["ko"], keys_by_locale["zh"], name)
        return keys_by_locale["ko"]

    def paired_keys(self, body):
        pair = re.compile(r"(\w+)\s*:\s*\[\s*(" + STRING + r")\s*,\s*(" + STRING + r")\s*\]\s*,?")
        entries = pair.findall(body)
        self.assertTrue(entries)
        self.assertFalse(pair.sub("", body).strip(), "Expected one Korean and one Chinese value for each key")
        keys = set()
        for key, ko, zh in entries:
            self.assertTrue(ast.literal_eval(ko).strip() and ast.literal_eval(zh).strip(), key)
            self.assertNotIn(key, keys)
            keys.add(key)
        return keys

    def test_agent_barcode_and_weigh_catalogs_have_both_languages(self):
        agent = (STATIC / "agent.js").read_text(encoding="utf-8")
        self.paired_keys(dictionary(agent, "codes"))
        for name in ("agent", "barcode", "weigh"):
            with self.subTest(name=name):
                known = self.catalog_keys(name)
                source = (STATIC / (name + ".js")).read_text(encoding="utf-8")
                literal_keys = set(re.findall(r"\b(?:t|text)\('(\w+)'\)", source))
                self.assertFalse(literal_keys - known)

    def test_template_labels_are_catalogued_without_hardcoded_visible_copy(self):
        template = TemplateAudit()
        template.feed((STATIC / "index.html").read_text(encoding="utf-8"))
        self.assertEqual(template.hardcoded, [])
        catalogs = {name: self.catalog_keys(name) for name in ("agent", "barcode", "weigh")}
        for catalog, key, line in template.references:
            self.assertIn(key, catalogs[catalog], "index.html:{}".format(line))
