#!/usr/bin/env python3 -I
"""Turns the CustomResourceDefinitions in one or more multi-document YAML files into JSON Schemas that
kubeconform can use, laid out as <out>/<group>/<kind>_<version>.json (lower-case kind).

Like kubeconform's openapi2jsonschema.py with -strict: objects that list `properties` get
`additionalProperties: false`, so a misspelt field is an error. Objects marked
`x-kubernetes-preserve-unknown-fields` are left open. Needs PyYAML.

usage: crd-to-jsonschema.py <out-dir> <crd-file>...
"""
import json
import sys
from pathlib import Path

import yaml


def convert(node):
    if isinstance(node, list):
        return [convert(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {k: convert(v) for k, v in node.items() if not k.startswith("x-kubernetes-")}
    if node.get("x-kubernetes-int-or-string"):
        out["anyOf"] = [{"type": "integer"}, {"type": "string"}]
        out.pop("type", None)
    if (
        out.get("type") == "object"
        and "properties" in out
        and "additionalProperties" not in out
        and not node.get("x-kubernetes-preserve-unknown-fields")
    ):
        out["additionalProperties"] = False
    return out


def main(argv):
    out_dir, files = Path(argv[1]), argv[2:]
    count = 0
    for file in files:
        for doc in yaml.safe_load_all(Path(file).read_text()):
            if not doc or doc.get("kind") != "CustomResourceDefinition":
                continue
            spec = doc["spec"]
            for version in spec["versions"]:
                schema = version.get("schema", {}).get("openAPIV3Schema")
                if not schema:
                    continue
                target = out_dir / spec["group"] / f"{spec['names']['kind'].lower()}_{version['name']}.json"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(convert(schema)))
                count += 1
    print(f"wrote {count} schemas to {out_dir}")


main(sys.argv)
