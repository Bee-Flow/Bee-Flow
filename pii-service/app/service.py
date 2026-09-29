"""
CPU PII Detection — betterdataai/PII_DETECTION_MODEL

This is a GENERATIVE model (Qwen2-0.5B) that detects PII by responding
to a structured prompt. It returns categories like <iban>, <email>,
<name>, <phone_number>, <credit_card_number>, etc.

Supported classes:
  pin, api_key, bank_routing_number, bban, company, credit_card_number,
  credit_card_security_code, customer_id, date, date_of_birth, date_time,
  driver_license_number, email, employee_id, first_name, iban, ipv4, ipv6,
  last_name, local_latlng, name, passport_number, password, phone_number,
  social_security_number, street_address, swift_bic_code, time, user_name
"""

from __future__ import annotations

import logging
import re
import threading
from typing import Optional

logger = logging.getLogger("pii")

# All classes the model can detect
PII_CLASSES = [
    "<pin>",
    "<api_key>",
    "<bank_routing_number>",
    "<bban>",
    "<company>",
    "<credit_card_number>",
    "<credit_card_security_code>",
    "<customer_id>",
    "<date>",
    "<date_of_birth>",
    "<date_time>",
    "<driver_license_number>",
    "<email>",
    "<employee_id>",
    "<first_name>",
    "<iban>",
    "<ipv4>",
    "<ipv6>",
    "<last_name>",
    "<local_latlng>",
    "<name>",
    "<passport_number>",
    "<password>",
    "<phone_number>",
    "<social_security_number>",
    "<street_address>",
    "<swift_bic_code>",
    "<time>",
    "<user_name>",
]

# Map model class tags → human readable labels (matching our JS PII_CATEGORIES)
CATEGORY_LABELS = {
    "pin": "PIN",
    "api_key": "API Key",
    "bank_routing_number": "Bank Routing Number",
    "bban": "Bank Account Number",
    "company": "Organization",
    "credit_card_number": "Credit Card Number",
    "credit_card_security_code": "Credit Card CVV",
    "customer_id": "Customer ID",
    "date": "Date",
    "date_of_birth": "Date of Birth",
    "date_time": "Date/Time",
    "driver_license_number": "Driver's License",
    "email": "Email Address",
    "employee_id": "Employee ID",
    "first_name": "Person Name",
    "iban": "IBAN",
    "ipv4": "IP Address",
    "ipv6": "IP Address",
    "last_name": "Person Name",
    "local_latlng": "Location Coordinates",
    "name": "Person Name",
    "passport_number": "Passport Number",
    "password": "Password",
    "phone_number": "Phone Number",
    "social_security_number": "SSN",
    "street_address": "Physical Address",
    "swift_bic_code": "SWIFT/BIC Code",
    "time": "Time",
    "user_name": "Username",
}

PROMPT_TEMPLATE = """\
You are an AI assistant who is responsible for identifying Personal Identifiable information (PII). \
You will be given a passage of text and you have to identify the PII data present in the passage. \
You should only identify the data based on the classes provided and not make up any class on your own.
```PII Classes```
{classes}
The given text is: {text}
The PII data are:
"""


class PiiService:
    """Singleton generative model for CPU-based PII detection."""

    _instance: Optional["PiiService"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "PiiService":
        with cls._lock:
            if cls._instance is None:
                obj = super().__new__(cls)
                obj._model = None
                obj._tokenizer = None
                obj._model_id = None
                obj._ready = False
                cls._instance = obj
        return cls._instance

    def load(self, model_id: str) -> None:
        with self._lock:
            if self._ready and self._model_id == model_id:
                return
            logger.info("[PiiService] Loading model %s …", model_id)
            try:
                import os
                import torch
                from transformers import AutoModelForCausalLM, AutoTokenizer

                # Use all available CPU cores (no-op on GPU but harmless)
                torch.set_num_threads(os.cpu_count() or 4)

                # Auto-select device: GPU if available, CPU otherwise
                use_gpu = torch.cuda.is_available()
                device = "cuda" if use_gpu else "cpu"
                logger.info(
                    "[PiiService] Device: %s (%s)",
                    device,
                    torch.cuda.get_device_name(0) if use_gpu else "CPU",
                )

                tokenizer = AutoTokenizer.from_pretrained(model_id)

                if use_gpu:
                    # GPU: use float16 for best throughput on NVIDIA
                    model = AutoModelForCausalLM.from_pretrained(
                        model_id,
                        torch_dtype=torch.float16,
                        device_map="auto",  # requires accelerate
                    )
                    logger.info("[PiiService] Loaded on GPU in float16")
                else:
                    # CPU: use bfloat16 for faster inference on modern CPUs
                    try:
                        model = AutoModelForCausalLM.from_pretrained(
                            model_id,
                            torch_dtype=torch.bfloat16,
                        )
                        logger.info("[PiiService] Loaded on CPU in bfloat16")
                    except Exception:
                        model = AutoModelForCausalLM.from_pretrained(model_id)
                        logger.info("[PiiService] Loaded on CPU in float32")

                model.eval()
                self._tokenizer = tokenizer
                self._model = model
                self._model_id = model_id
                self._ready = True
                logger.info("[PiiService] Model %s ready", model_id)
            except Exception as exc:
                logger.error("[PiiService] Failed to load model %s: %s", model_id, exc)
                self._model = None
                self._tokenizer = None
                self._ready = False

    @property
    def ready(self) -> bool:
        return self._ready

    def detect(
        self,
        text: str,
        confidence_threshold: float = 0.3,
        enabled_categories: list[str] | None = None,
    ) -> dict:
        """
        Run PII detection using the generative model.

        Only includes enabled_categories in the prompt (shorter prompt = faster).
        Returns entities with specific categories (iban, email, name, etc.)
        """
        if not self._ready or self._model is None:
            logger.warning("[PiiService] Model not ready, returning empty result")
            return {"hasPii": False, "entities": []}

        import torch

        # Only include the classes the admin has enabled — shorter prompt = fewer tokens = faster
        if enabled_categories:
            enabled_lower = {c.lower() for c in enabled_categories}
            active_classes = [c for c in PII_CLASSES if c.strip("<>") in enabled_lower]
            if not active_classes:
                active_classes = PII_CLASSES  # fallback to all
        else:
            active_classes = PII_CLASSES

        classes_str = "\n".join(active_classes)
        prompt = PROMPT_TEMPLATE.format(classes=classes_str, text=text)

        inputs = self._tokenizer(prompt, return_tensors="pt").to(self._model.device)
        with torch.inference_mode():
            output = self._model.generate(
                **inputs,
                max_new_tokens=128,
                do_sample=False,
                pad_token_id=self._tokenizer.eos_token_id,
            )

        full_text = self._tokenizer.decode(output[0], skip_special_tokens=True)
        return self._postprocess(
            full_text, text, confidence_threshold, enabled_categories
        )

    def _postprocess(
        self,
        full_text: str,
        text: str,
        confidence_threshold: float,
        enabled_categories: list[str] | None,
    ) -> dict:
        """Turn the model's answer into entities. Logs counts and categories only:
        the values are the personal data this service exists to keep out of logs."""
        marker = "The PII data are:"
        if marker in full_text:
            pii_output = full_text.split(marker)[-1].strip()
        else:
            logger.warning(
                "[PiiService] Unexpected output format (%d chars, no marker)",
                len(full_text),
            )
            return {"hasPii": False, "entities": []}

        logger.info("[PiiService] Model output parsed (%d chars)", len(pii_output))

        entities = self._parse_output(pii_output, text, confidence_threshold)

        # Filter by enabled_categories if specified
        if enabled_categories:
            enabled_lower = {c.lower() for c in enabled_categories}
            entities = [
                e
                for e in entities
                if e["category"].lower() in enabled_lower
                or e["label"].lower() in enabled_lower
            ]

        logger.info(
            "[PiiService] Detected %d entities: %s",
            len(entities),
            ", ".join(sorted({e["category"] for e in entities})),
        )

        return {"hasPii": len(entities) > 0, "entities": entities}

    def _parse_output(
        self, pii_output: str, original_text: str, confidence_threshold: float
    ) -> list[dict]:
        """
        Parse model output like:
          <iban> : ['NL38ABNA1011359161']
          <name> : ['Julia']
        Into entity dicts with offsets into original_text.
        """
        entities = []
        # Match patterns like: <category> : ['value1', 'value2']
        pattern = re.compile(r"<(\w+)>\s*:\s*\[([^\]]*)\]")

        # This generative backend cannot emit per-token confidence scores, so we
        # report a fixed high score. Honour the caller's threshold anyway: if it
        # is raised above this value the backend correctly returns nothing,
        # keeping threshold behaviour monotonic across both PII backends.
        FIXED_CONFIDENCE = 0.95
        if FIXED_CONFIDENCE < (confidence_threshold or 0):
            return []

        # Per-value cursor so repeated values map to successive occurrences
        # instead of all collapsing onto the first match. Without this,
        # "Jack Smith and Jack Brown" would point both "Jack" detections at the
        # same offset, and the JS tokeniser (which splices by offset) would
        # corrupt the second span. Keyed by the lowercased needle.
        search_cursors: dict[str, int] = {}
        haystack = original_text.lower()

        for match in pattern.finditer(pii_output):
            raw_category = match.group(1)
            values_str = match.group(2)

            label = CATEGORY_LABELS.get(
                raw_category, raw_category.replace("_", " ").title()
            )

            # Extract quoted values
            values = re.findall(r"'([^']*)'|\"([^\"]*)\"", values_str)
            for v_tuple in values:
                value = v_tuple[0] or v_tuple[1]
                if not value.strip():
                    continue

                # Find offset in original text (case-insensitive), advancing past
                # previously-matched occurrences of the same value.
                needle = value.lower()
                start_from = search_cursors.get(needle, 0)
                idx = haystack.find(needle, start_from)
                if idx < 0 and start_from > 0:
                    # Model repeated a value more times than it appears in the
                    # text — fall back to the first occurrence so it still maps
                    # to a real span rather than offset 0.
                    idx = haystack.find(needle)
                if idx >= 0:
                    search_cursors[needle] = idx + len(value)
                    offset = idx
                    actual_text = original_text[offset : offset + len(value)]
                else:
                    offset = 0
                    actual_text = value

                entities.append(
                    {
                        "text": actual_text,
                        "category": raw_category,
                        "label": label,
                        "confidence": FIXED_CONFIDENCE,  # generative model has no per-token scores
                        "offset": offset,
                        "length": len(value),
                    }
                )

        return entities


_service = PiiService()


def get_pii_service() -> PiiService:
    return _service
