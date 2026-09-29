/**
 * GENERATED — do not edit by hand.
 *   cd server && node scripts/genComplianceDemoCatalog.js
 *
 * The framework catalogue, its regulatory milestones, the check registry, the
 * ISO 27001 Annex A catalog and the evidence-connector
 * catalog, as the compliance demo needs them. Generated from the server's own
 * definitions so the demo cannot drift from the product: every check id here
 * exists, every titleKey resolves against the bundled EN defaults, and every
 * control's `checks` cross-reference names a real check.
 *
 * Regenerate after adding a check, a control or a connector.
 */

export const FRAMEWORKS = [
    {
        "id": "gdpr",
        "regulation": "GDPR",
        "regulation_code": "Verordening (EU) 2016/679 · UAVG",
        "name_key": "compliance.fw_gdpr_name",
        "description_key": "compliance.fw_gdpr_desc",
        "affects_key": "compliance.fw_gdpr_affects",
        "core": true,
        "capability": "compliance_hub_gdpr",
        "checks_dir": "gdpr",
        "checks_count": 21,
        "in_force_since": "2018-05-25",
        "in_force_from": null,
        "phases": [
            {
                "date": "2018-05-25",
                "label_key": "compliance.fw_gdpr_phase_in_force"
            }
        ],
        "registers": [
            "dsr",
            "incidents",
            "ropa",
            "dpia"
        ],
        "relevance_gate": false
    },
    {
        "id": "aia",
        "regulation": "AIA",
        "regulation_code": "Verordening (EU) 2024/1689",
        "name_key": "compliance.fw_aia_name",
        "description_key": "compliance.fw_aia_desc",
        "affects_key": "compliance.fw_aia_affects",
        "core": true,
        "capability": "compliance_hub_aia",
        "checks_dir": "aia",
        "checks_count": 7,
        "in_force_since": "2024-08-01",
        "in_force_from": null,
        "phases": [
            {
                "date": "2025-02-02",
                "label_key": "compliance.fw_aia_phase_art4_art5"
            },
            {
                "date": "2025-08-02",
                "label_key": "compliance.fw_aia_phase_gpai"
            },
            {
                "date": "2026-08-02",
                "label_key": "compliance.fw_aia_phase_art50"
            },
            {
                "date": "2026-12-02",
                "label_key": "compliance.fw_aia_phase_marking_transition_end"
            },
            {
                "date": "2027-12-02",
                "label_key": "compliance.fw_aia_phase_annex_iii"
            },
            {
                "date": "2028-08-02",
                "label_key": "compliance.fw_aia_phase_annex_i"
            }
        ],
        "registers": [],
        "relevance_gate": false
    },
    {
        "id": "iso27001",
        "regulation": "ISO27001",
        "regulation_code": "ISO/IEC 27001:2022",
        "name_key": "compliance.fw_iso27001_name",
        "description_key": "compliance.fw_iso27001_desc",
        "affects_key": "compliance.fw_iso27001_affects",
        "core": true,
        "capability": "compliance_hub_iso27001",
        "checks_dir": "iso27001",
        "checks_count": 63,
        "in_force_since": null,
        "in_force_from": null,
        "phases": [],
        "registers": [
            "risks",
            "soa",
            "policies",
            "audits",
            "training",
            "access_log",
            "connectors"
        ],
        "relevance_gate": false
    },
    {
        "id": "nis2",
        "regulation": "NIS2",
        "regulation_code": "Richtlijn (EU) 2022/2555 · Cyberbeveiligingswet",
        "name_key": "compliance.fw_nis2_name",
        "description_key": "compliance.fw_nis2_desc",
        "affects_key": "compliance.fw_nis2_affects",
        "core": false,
        "capability": "compliance_hub_nis2",
        "checks_dir": "nis2",
        "checks_count": 36,
        "in_force_since": "2026-08-15",
        "in_force_from": null,
        "phases": [
            {
                "date": "2026-08-15",
                "label_key": "compliance.fw_nis2_phase_in_force"
            }
        ],
        "registers": [
            "incidents"
        ],
        "relevance_gate": false
    },
    {
        "id": "cra",
        "regulation": "CRA",
        "regulation_code": "Verordening (EU) 2024/2847",
        "name_key": "compliance.fw_cra_name",
        "description_key": "compliance.fw_cra_desc",
        "affects_key": "compliance.fw_cra_affects",
        "core": false,
        "capability": "compliance_hub_cra",
        "checks_dir": "cra",
        "checks_count": 12,
        "in_force_since": "2026-09-11",
        "in_force_from": null,
        "phases": [
            {
                "date": "2026-09-11",
                "label_key": "compliance.fw_cra_phase_reporting"
            },
            {
                "date": "2027-12-11",
                "label_key": "compliance.fw_cra_phase_full"
            }
        ],
        "registers": [
            "vulnerabilities"
        ],
        "relevance_gate": false
    },
    {
        "id": "data_act",
        "regulation": "DATA_ACT",
        "regulation_code": "Verordening (EU) 2023/2854",
        "name_key": "compliance.fw_data_act_name",
        "description_key": "compliance.fw_data_act_desc",
        "affects_key": "compliance.fw_data_act_affects",
        "core": false,
        "capability": "compliance_hub_data_act",
        "checks_dir": "data-act",
        "checks_count": 4,
        "in_force_since": "2025-09-12",
        "in_force_from": null,
        "phases": [
            {
                "date": "2025-09-12",
                "label_key": "compliance.fw_data_act_phase_in_force"
            },
            {
                "date": "2027-01-12",
                "label_key": "compliance.fw_data_act_phase_switching_charges"
            }
        ],
        "registers": [
            "portability"
        ],
        "relevance_gate": false
    },
    {
        "id": "pld",
        "regulation": "PLD",
        "regulation_code": "Richtlijn (EU) 2024/2853",
        "name_key": "compliance.fw_pld_name",
        "description_key": "compliance.fw_pld_desc",
        "affects_key": "compliance.fw_pld_affects",
        "core": false,
        "capability": "compliance_hub_pld",
        "checks_dir": "pld",
        "checks_count": 3,
        "in_force_since": null,
        "in_force_from": "2026-12-09",
        "phases": [
            {
                "date": "2026-12-09",
                "label_key": "compliance.fw_pld_phase_in_force"
            }
        ],
        "registers": [],
        "relevance_gate": false
    },
    {
        "id": "eaa",
        "regulation": "EAA",
        "regulation_code": "Richtlijn (EU) 2019/882",
        "name_key": "compliance.fw_eaa_name",
        "description_key": "compliance.fw_eaa_desc",
        "affects_key": "compliance.fw_eaa_affects",
        "core": false,
        "capability": "compliance_hub_eaa",
        "checks_dir": "eaa",
        "checks_count": 3,
        "in_force_since": "2025-06-28",
        "in_force_from": null,
        "phases": [
            {
                "date": "2025-06-28",
                "label_key": "compliance.fw_eaa_phase_in_force"
            },
            {
                "date": "2030-06-28",
                "label_key": "compliance.fw_eaa_phase_legacy_contracts_end"
            }
        ],
        "registers": [],
        "relevance_gate": false
    },
    {
        "id": "dora",
        "regulation": "DORA",
        "regulation_code": "Verordening (EU) 2022/2554",
        "name_key": "compliance.fw_dora_name",
        "description_key": "compliance.fw_dora_desc",
        "affects_key": "compliance.fw_dora_affects",
        "core": false,
        "capability": "compliance_hub_dora",
        "checks_dir": "dora",
        "checks_count": 10,
        "in_force_since": "2025-01-17",
        "in_force_from": null,
        "phases": [
            {
                "date": "2025-01-17",
                "label_key": "compliance.fw_dora_phase_in_force"
            }
        ],
        "registers": [
            "incidents"
        ],
        "relevance_gate": true
    },
    {
        "id": "machinery",
        "regulation": "MACHINERY",
        "regulation_code": "Verordening (EU) 2023/1230",
        "name_key": "compliance.fw_machinery_name",
        "description_key": "compliance.fw_machinery_desc",
        "affects_key": "compliance.fw_machinery_affects",
        "core": false,
        "capability": "compliance_hub_machinery",
        "checks_dir": "machinery",
        "checks_count": 2,
        "in_force_since": null,
        "in_force_from": "2027-01-20",
        "phases": [
            {
                "date": "2027-01-20",
                "label_key": "compliance.fw_machinery_phase_in_force"
            }
        ],
        "registers": [],
        "relevance_gate": true
    }
];

export const MILESTONES = [
    {
        "id": "dora_in_force",
        "date": "2025-01-17",
        "expected": null,
        "framework_id": "dora",
        "kind": "in_force",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_dora_in_force_label",
        "detail_key": "compliance.cal_ms_dora_in_force_detail"
    },
    {
        "id": "aia_art4_art5",
        "date": "2025-02-02",
        "expected": null,
        "framework_id": "aia",
        "kind": "phase",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_aia_art4_art5_label",
        "detail_key": "compliance.cal_ms_aia_art4_art5_detail"
    },
    {
        "id": "eaa_in_force",
        "date": "2025-06-28",
        "expected": null,
        "framework_id": "eaa",
        "kind": "in_force",
        "affects_kind": "a11y",
        "label_key": "compliance.cal_ms_eaa_in_force_label",
        "detail_key": "compliance.cal_ms_eaa_in_force_detail"
    },
    {
        "id": "aia_gpai",
        "date": "2025-08-02",
        "expected": null,
        "framework_id": "aia",
        "kind": "phase",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_aia_gpai_label",
        "detail_key": "compliance.cal_ms_aia_gpai_detail"
    },
    {
        "id": "data_act_in_force",
        "date": "2025-09-12",
        "expected": null,
        "framework_id": "data_act",
        "kind": "in_force",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_data_act_in_force_label",
        "detail_key": "compliance.cal_ms_data_act_in_force_detail"
    },
    {
        "id": "aia_art50_enforcement",
        "date": "2026-08-02",
        "expected": null,
        "framework_id": "aia",
        "kind": "phase",
        "affects_kind": "marking",
        "label_key": "compliance.cal_ms_aia_art50_enforcement_label",
        "detail_key": "compliance.cal_ms_aia_art50_enforcement_detail"
    },
    {
        "id": "nis2_in_force",
        "date": "2026-08-15",
        "expected": null,
        "framework_id": "nis2",
        "kind": "in_force",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_nis2_in_force_label",
        "detail_key": "compliance.cal_ms_nis2_in_force_detail"
    },
    {
        "id": "cra_reporting_duty",
        "date": "2026-09-11",
        "expected": null,
        "framework_id": "cra",
        "kind": "in_force",
        "affects_kind": "releases",
        "label_key": "compliance.cal_ms_cra_reporting_duty_label",
        "detail_key": "compliance.cal_ms_cra_reporting_duty_detail"
    },
    {
        "id": "aia_marking_transition_end",
        "date": "2026-12-02",
        "expected": null,
        "framework_id": "aia",
        "kind": "transition_end",
        "affects_kind": "marking",
        "label_key": "compliance.cal_ms_aia_marking_transition_end_label",
        "detail_key": "compliance.cal_ms_aia_marking_transition_end_detail"
    },
    {
        "id": "pld_in_force",
        "date": "2026-12-09",
        "expected": null,
        "framework_id": "pld",
        "kind": "in_force",
        "affects_kind": "releases",
        "label_key": "compliance.cal_ms_pld_in_force_label",
        "detail_key": "compliance.cal_ms_pld_in_force_detail"
    },
    {
        "id": "data_act_switching_charges",
        "date": "2027-01-12",
        "expected": null,
        "framework_id": "data_act",
        "kind": "phase",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_data_act_switching_charges_label",
        "detail_key": "compliance.cal_ms_data_act_switching_charges_detail"
    },
    {
        "id": "machinery_in_force",
        "date": "2027-01-20",
        "expected": null,
        "framework_id": "machinery",
        "kind": "in_force",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_machinery_in_force_label",
        "detail_key": "compliance.cal_ms_machinery_in_force_detail"
    },
    {
        "id": "aia_annex_iii",
        "date": "2027-12-02",
        "expected": null,
        "framework_id": "aia",
        "kind": "phase",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_aia_annex_iii_label",
        "detail_key": "compliance.cal_ms_aia_annex_iii_detail"
    },
    {
        "id": "cra_full",
        "date": "2027-12-11",
        "expected": null,
        "framework_id": "cra",
        "kind": "phase",
        "affects_kind": "releases",
        "label_key": "compliance.cal_ms_cra_full_label",
        "detail_key": "compliance.cal_ms_cra_full_detail"
    },
    {
        "id": "aia_annex_i",
        "date": "2028-08-02",
        "expected": null,
        "framework_id": "aia",
        "kind": "phase",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_aia_annex_i_label",
        "detail_key": "compliance.cal_ms_aia_annex_i_detail"
    },
    {
        "id": "eaa_legacy_contracts_end",
        "date": "2030-06-28",
        "expected": null,
        "framework_id": "eaa",
        "kind": "transition_end",
        "affects_kind": "a11y",
        "label_key": "compliance.cal_ms_eaa_legacy_contracts_end_label",
        "detail_key": "compliance.cal_ms_eaa_legacy_contracts_end_detail"
    },
    {
        "id": "omnibus_data_part",
        "date": null,
        "expected": "2026-Q4",
        "framework_id": "gdpr",
        "kind": "uncertain",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_omnibus_data_part_label",
        "detail_key": "compliance.cal_ms_omnibus_data_part_detail"
    },
    {
        "id": "nl_uitvoeringswet_ai",
        "date": null,
        "expected": "2026-Q4",
        "framework_id": "aia",
        "kind": "uncertain",
        "affects_kind": null,
        "label_key": "compliance.cal_ms_nl_uitvoeringswet_ai_label",
        "detail_key": "compliance.cal_ms_nl_uitvoeringswet_ai_detail"
    }
];

export const CHECK_DEFS = [
    {
        "check_id": "GDPR-Art12-privacy-notice",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "12",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "12",
        "severity": "medium",
        "scope": "global",
        "verification": "attestation",
        "titleKey": "compliance.checks.gdpr_art12.title",
        "descriptionKey": "compliance.checks.gdpr_art12.desc",
        "remediationKey": "compliance.checks.gdpr_art12.fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art15-dsr-access",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "15",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "15",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art15.title",
        "descriptionKey": "compliance.checks.gdpr_art15.desc",
        "remediationKey": "compliance.checks.gdpr_art15.fix",
        "remediationLink": "admin/compliance/dsr",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art17-dsr-deletion",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "17",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "17",
        "severity": "critical",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art17.title",
        "descriptionKey": "compliance.checks.gdpr_art17.desc",
        "remediationKey": "compliance.checks.gdpr_art17.fix",
        "remediationLink": "admin/compliance/dsr",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art28-subprocessors",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "28",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.20",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(d)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "DORA",
                "ref": "Art. 28(3)",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "28",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art28.title",
        "descriptionKey": "compliance.checks.gdpr_art28.desc",
        "remediationKey": "compliance.checks.gdpr_art28.fix",
        "remediationLink": "admin/compliance/ropa",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art30-ropa-reviewed",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "30",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "30",
        "severity": "medium",
        "scope": "global",
        "verification": "attestation",
        "titleKey": "compliance.checks.gdpr_art30.title",
        "descriptionKey": "compliance.checks.gdpr_art30.desc",
        "remediationKey": "compliance.checks.gdpr_art30.fix",
        "remediationLink": "admin/compliance/ropa",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art32-access-logging",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "32",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "32",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art32_log.title",
        "descriptionKey": "compliance.checks.gdpr_art32_log.desc",
        "remediationKey": "compliance.checks.gdpr_art32_log.fix",
        "remediationLink": "admin/monitoring/activity",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art32-dlp-efficacy",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "32",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "32",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art32_eff.title",
        "descriptionKey": "compliance.checks.gdpr_art32_eff.desc",
        "remediationKey": "compliance.checks.gdpr_art32_eff.fix",
        "remediationLink": "admin/security/guardrails",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art32-dlp-enabled",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "32",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.12",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "32",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art32_dlp.title",
        "descriptionKey": "compliance.checks.gdpr_art32_dlp.desc",
        "remediationKey": "compliance.checks.gdpr_art32_dlp.fix",
        "remediationLink": "admin/security/guardrails",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art32-encryption-at-rest",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "32",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(h)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "32",
        "severity": "critical",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art32_ear.title",
        "descriptionKey": "compliance.checks.gdpr_art32_ear.desc",
        "remediationKey": "compliance.checks.gdpr_art32_ear.fix",
        "remediationLink": null,
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art32-encryption-in-transit",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "32",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(h)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "32",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art32_eit.title",
        "descriptionKey": "compliance.checks.gdpr_art32_eit.desc",
        "remediationKey": "compliance.checks.gdpr_art32_eit.fix",
        "remediationLink": null,
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art33-breach-detection",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "33",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.24",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "33",
        "severity": "high",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.checks.gdpr_art33.title",
        "descriptionKey": "compliance.checks.gdpr_art33.desc",
        "remediationKey": "compliance.checks.gdpr_art33.fix",
        "remediationLink": "admin/compliance/incidents",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art35-dpia-high-risk",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "35",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "35",
        "severity": "high",
        "scope": "per-source",
        "verification": "attestation",
        "titleKey": "compliance.checks.gdpr_art35.title",
        "descriptionKey": "compliance.checks.gdpr_art35.desc",
        "remediationKey": "compliance.checks.gdpr_art35.fix",
        "remediationLink": "admin/compliance/dpia",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art37-dpo-appointed",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "37",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "37",
        "severity": "high",
        "scope": "global",
        "verification": "attestation",
        "titleKey": "compliance.checks.gdpr_art37.title",
        "descriptionKey": "compliance.checks.gdpr_art37.desc",
        "remediationKey": "compliance.checks.gdpr_art37.fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art44-external-transfers",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "44",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "44",
        "severity": "high",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.checks.gdpr_art44.title",
        "descriptionKey": "compliance.checks.gdpr_art44.desc",
        "remediationKey": "compliance.checks.gdpr_art44.fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "GDPR-Art5-1-e-storage-limitation",
        "regulation": "GDPR",
        "framework_id": "gdpr",
        "frameworks": [
            {
                "regulation": "GDPR",
                "ref": "5(1)(e)",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2018-05-25",
        "article": "5(1)(e)",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.gdpr_art5_1_e.title",
        "descriptionKey": "compliance.checks.gdpr_art5_1_e.desc",
        "remediationKey": "compliance.checks.gdpr_art5_1_e.fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "AIA-Art13-transparency",
        "regulation": "AIA",
        "framework_id": "aia",
        "frameworks": [
            {
                "regulation": "AIA",
                "ref": "13",
                "framework_id": "aia",
                "in_force_since": "2024-08-01"
            }
        ],
        "in_force_since": "2024-08-01",
        "article": "13",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.aia_art13.title",
        "descriptionKey": "compliance.checks.aia_art13.desc",
        "remediationKey": "compliance.checks.aia_art13.fix",
        "remediationLink": "admin/agents",
        "autoFixId": null
    },
    {
        "check_id": "AIA-Art26-6-log-retention",
        "regulation": "AIA",
        "framework_id": "aia",
        "frameworks": [
            {
                "regulation": "AIA",
                "ref": "26(6)",
                "framework_id": "aia",
                "in_force_since": "2024-08-01"
            }
        ],
        "in_force_since": "2024-08-01",
        "article": "26(6)",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.aia_art26_6.title",
        "descriptionKey": "compliance.checks.aia_art26_6.desc",
        "remediationKey": "compliance.checks.aia_art26_6.fix",
        "remediationLink": "admin/monitoring/activity",
        "autoFixId": null
    },
    {
        "check_id": "AIA-Art26-human-oversight",
        "regulation": "AIA",
        "framework_id": "aia",
        "frameworks": [
            {
                "regulation": "AIA",
                "ref": "26",
                "framework_id": "aia",
                "in_force_since": "2024-08-01"
            }
        ],
        "in_force_since": "2024-08-01",
        "article": "26",
        "severity": "high",
        "scope": "per-source",
        "verification": "attestation",
        "titleKey": "compliance.checks.aia_art26.title",
        "descriptionKey": "compliance.checks.aia_art26.desc",
        "remediationKey": "compliance.checks.aia_art26.fix",
        "remediationLink": "admin/compliance/dpia",
        "autoFixId": null
    },
    {
        "check_id": "AIA-Art4-ai-literacy",
        "regulation": "AIA",
        "framework_id": "aia",
        "frameworks": [
            {
                "regulation": "AIA",
                "ref": "4",
                "framework_id": "aia",
                "in_force_since": "2025-02-02"
            }
        ],
        "in_force_since": "2025-02-02",
        "article": "4",
        "severity": "medium",
        "scope": "global",
        "verification": "attestation",
        "titleKey": "compliance.checks.aia_art4.title",
        "descriptionKey": "compliance.checks.aia_art4.desc",
        "remediationKey": "compliance.checks.aia_art4.fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "AIA-Art50-ai-disclosure",
        "regulation": "AIA",
        "framework_id": "aia",
        "frameworks": [
            {
                "regulation": "AIA",
                "ref": "50",
                "framework_id": "aia",
                "in_force_since": "2026-08-02"
            }
        ],
        "in_force_since": "2026-08-02",
        "article": "50",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.aia_art50.title",
        "descriptionKey": "compliance.checks.aia_art50.desc",
        "remediationKey": "compliance.checks.aia_art50.fix",
        "remediationLink": "admin/agents",
        "autoFixId": "aia_art50_inject_disclosure"
    },
    {
        "check_id": "AIA-Art50-content-marking",
        "regulation": "AIA",
        "framework_id": "aia",
        "frameworks": [
            {
                "regulation": "AIA",
                "ref": "50(2)",
                "framework_id": "aia",
                "in_force_since": "2026-08-02"
            }
        ],
        "in_force_since": "2026-08-02",
        "article": "50(2)",
        "severity": "high",
        "scope": "per-source",
        "verification": "automated",
        "titleKey": "compliance.check_aia_art50_marking_title",
        "descriptionKey": "compliance.check_aia_art50_marking_desc",
        "remediationKey": "compliance.check_aia_art50_marking_fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "AIA-Art53-model-inventory",
        "regulation": "AIA",
        "framework_id": "aia",
        "frameworks": [
            {
                "regulation": "AIA",
                "ref": "53",
                "framework_id": "aia",
                "in_force_since": "2025-08-02"
            }
        ],
        "in_force_since": "2025-08-02",
        "article": "53",
        "severity": "medium",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.checks.aia_art53.title",
        "descriptionKey": "compliance.checks.aia_art53.desc",
        "remediationKey": "compliance.checks.aia_art53.fix",
        "remediationLink": "admin/compliance/ropa",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.5.14-mail-security",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.5.14",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.26",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(j)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.5.14",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_mail_security.title",
        "descriptionKey": "compliance.checks.iso_mail_security.desc",
        "remediationKey": "compliance.checks.iso_mail_security.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.5.15-access-control",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.5.15",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.18",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.3",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(i)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.5.15",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_access_control.title",
        "descriptionKey": "compliance.checks.iso_access_control.desc",
        "remediationKey": "compliance.checks.iso_access_control.fix",
        "remediationLink": "admin/security/users",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.5.16-identity-hygiene",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.5.16",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.18",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.2",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(i)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.5.16",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_identity_hygiene.title",
        "descriptionKey": "compliance.checks.iso_identity_hygiene.desc",
        "remediationKey": "compliance.checks.iso_identity_hygiene.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.5.20-suppliers",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.5.20",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.22",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.23",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(d)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "DORA",
                "ref": "Art. 28(3)",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            }
        ],
        "in_force_since": null,
        "article": "A.5.20",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_suppliers.title",
        "descriptionKey": "compliance.checks.iso_suppliers.desc",
        "remediationKey": "compliance.checks.iso_suppliers.fix",
        "remediationLink": "admin/compliance/ropa",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.5.24-incident-mgmt",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.5.24",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.25",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.26",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(b)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 23",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "GDPR",
                "ref": "Art. 33",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            },
            {
                "regulation": "CRA",
                "ref": "Art. 14",
                "framework_id": "cra",
                "in_force_since": "2026-09-11"
            },
            {
                "regulation": "DORA",
                "ref": "Art. 30",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            }
        ],
        "in_force_since": null,
        "article": "A.5.24",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_incident_mgmt.title",
        "descriptionKey": "compliance.checks.iso_incident_mgmt.desc",
        "remediationKey": "compliance.checks.iso_incident_mgmt.fix",
        "remediationLink": "admin/compliance/incidents",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.5.28-evidence-integrity",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.5.28",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.36",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": null,
        "article": "A.5.28",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_evidence_integrity.title",
        "descriptionKey": "compliance.checks.iso_evidence_integrity.desc",
        "remediationKey": "compliance.checks.iso_evidence_integrity.fix",
        "remediationLink": null,
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.5.9-asset-inventory",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.5.9",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(i)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.5.9",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_asset_inventory.title",
        "descriptionKey": "compliance.checks.iso_asset_inventory.desc",
        "remediationKey": "compliance.checks.iso_asset_inventory.fix",
        "remediationLink": "admin/compliance/ropa",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.6.5-offboarding-feed",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.6.5",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.6.1",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(i)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.6.5",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_offboarding_feed.title",
        "descriptionKey": "compliance.checks.iso_offboarding_feed.desc",
        "remediationKey": "compliance.checks.iso_offboarding_feed.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.10-deletion",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.10",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": null,
        "article": "A.8.10",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_deletion.title",
        "descriptionKey": "compliance.checks.iso_deletion.desc",
        "remediationKey": "compliance.checks.iso_deletion.fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.12-dlp",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.12",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.11",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": null,
        "article": "A.8.12",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_dlp.title",
        "descriptionKey": "compliance.checks.iso_dlp.desc",
        "remediationKey": "compliance.checks.iso_dlp.fix",
        "remediationLink": "admin/security/guardrails",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.13-backups",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.13",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.14",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(c)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.8.13",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_backups.title",
        "descriptionKey": "compliance.checks.iso_backups.desc",
        "remediationKey": "compliance.checks.iso_backups.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.15-logging",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.15",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.16",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(b)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.8.15",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_logging.title",
        "descriptionKey": "compliance.checks.iso_logging.desc",
        "remediationKey": "compliance.checks.iso_logging.fix",
        "remediationLink": "admin/monitoring/activity",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.16-monitoring",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.16",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.17",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(b)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.8.16",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_monitoring.title",
        "descriptionKey": "compliance.checks.iso_monitoring.desc",
        "remediationKey": "compliance.checks.iso_monitoring.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.19-workplace-software",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.19",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.8",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": null,
        "article": "A.8.19",
        "severity": "low",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_workplace_software.title",
        "descriptionKey": "compliance.checks.iso_workplace_software.desc",
        "remediationKey": "compliance.checks.iso_workplace_software.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.20-network-exposure",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.20",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.22",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(e)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "CRA",
                "ref": "Annex I Part I",
                "framework_id": "cra",
                "in_force_since": "2026-09-11"
            }
        ],
        "in_force_since": null,
        "article": "A.8.20",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_network_exposure.title",
        "descriptionKey": "compliance.checks.iso_network_exposure.desc",
        "remediationKey": "compliance.checks.iso_network_exposure.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.24-cryptography",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.24",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(h)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.8.24",
        "severity": "critical",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_cryptography.title",
        "descriptionKey": "compliance.checks.iso_cryptography.desc",
        "remediationKey": "compliance.checks.iso_cryptography.fix",
        "remediationLink": null,
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.24-tls-endpoints",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.24",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(h)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.8.24",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_tls_endpoints.title",
        "descriptionKey": "compliance.checks.iso_tls_endpoints.desc",
        "remediationKey": "compliance.checks.iso_tls_endpoints.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.28-secure-coding",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.28",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(e)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "CRA",
                "ref": "Annex I Part I",
                "framework_id": "cra",
                "in_force_since": "2026-09-11"
            }
        ],
        "in_force_since": null,
        "article": "A.8.28",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_secure_coding.title",
        "descriptionKey": "compliance.checks.iso_secure_coding.desc",
        "remediationKey": "compliance.checks.iso_secure_coding.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.32-change-management",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.32",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.29",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(e)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "CRA",
                "ref": "Annex I Part II(3)",
                "framework_id": "cra",
                "in_force_since": "2026-09-11"
            }
        ],
        "in_force_since": null,
        "article": "A.8.32",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_change_mgmt.title",
        "descriptionKey": "compliance.checks.iso_change_mgmt.desc",
        "remediationKey": "compliance.checks.iso_change_mgmt.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.32-ticketed-changes",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.32",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": null,
        "article": "A.8.32",
        "severity": "low",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_ticketed_changes.title",
        "descriptionKey": "compliance.checks.iso_ticketed_changes.desc",
        "remediationKey": "compliance.checks.iso_ticketed_changes.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.4-source-protection",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.4",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.31",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(e)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "CRA",
                "ref": "Annex I Part I",
                "framework_id": "cra",
                "in_force_since": "2026-09-11"
            }
        ],
        "in_force_since": null,
        "article": "A.8.4",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_source_protection.title",
        "descriptionKey": "compliance.checks.iso_source_protection.desc",
        "remediationKey": "compliance.checks.iso_source_protection.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.5-secure-auth",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.5",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(j)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": null,
        "article": "A.8.5",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_secure_auth.title",
        "descriptionKey": "compliance.checks.iso_secure_auth.desc",
        "remediationKey": "compliance.checks.iso_secure_auth.fix",
        "remediationLink": "admin/security/sso",
        "autoFixId": null
    },
    {
        "check_id": "ISO27001-A.8.8-vuln-mgmt",
        "regulation": "ISO27001",
        "framework_id": "iso27001",
        "frameworks": [
            {
                "regulation": "ISO27001",
                "ref": "A.8.8",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(e)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "CRA",
                "ref": "Annex I Part II(2)",
                "framework_id": "cra",
                "in_force_since": "2026-09-11"
            }
        ],
        "in_force_since": null,
        "article": "A.8.8",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.checks.iso_vuln_mgmt.title",
        "descriptionKey": "compliance.checks.iso_vuln_mgmt.desc",
        "remediationKey": "compliance.checks.iso_vuln_mgmt.fix",
        "remediationLink": "admin/compliance/iso_connectors",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art21(2)(j)-admin-mfa",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(j)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.5",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "DORA",
                "ref": "Art. 9",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 21(2)(j)",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_nis2_admin_mfa_title",
        "descriptionKey": "compliance.check_nis2_admin_mfa_desc",
        "remediationKey": "compliance.check_nis2_admin_mfa_fix",
        "remediationLink": "admin/security/users",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art20-board-approval",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 20",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "cl. 5.1",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.1",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 20",
        "severity": "high",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.check_nis2_board_approval_title",
        "descriptionKey": "compliance.check_nis2_board_approval_desc",
        "remediationKey": "compliance.check_nis2_board_approval_fix",
        "remediationLink": "admin/compliance/policies",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art21(2)(g)-cyber-hygiene-training",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(g)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 20(2)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "cl. 7.2",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "cl. 7.3",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.6.3",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 21(2)(g)",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_nis2_training_title",
        "descriptionKey": "compliance.check_nis2_training_desc",
        "remediationKey": "compliance.check_nis2_training_fix",
        "remediationLink": "admin/compliance/training",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art23-early-warning-path",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 23",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "CRA",
                "ref": "Art. 14",
                "framework_id": "cra",
                "in_force_since": "2026-09-11"
            },
            {
                "regulation": "GDPR",
                "ref": "Art. 33",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 23",
        "severity": "critical",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_nis2_early_warning_title",
        "descriptionKey": "compliance.check_nis2_early_warning_desc",
        "remediationKey": "compliance.check_nis2_early_warning_fix",
        "remediationLink": "admin/compliance/incidents",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art21(2)(f)-effectiveness-review",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(f)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "cl. 9.2",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "cl. 9.3",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 21(2)(f)",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_nis2_effectiveness_review_title",
        "descriptionKey": "compliance.check_nis2_effectiveness_review_desc",
        "remediationKey": "compliance.check_nis2_effectiveness_review_fix",
        "remediationLink": "admin/compliance/audits",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art21(2)-policy-coverage",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.1",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "cl. 7.5",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 21(2)",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_nis2_policy_coverage_title",
        "descriptionKey": "compliance.check_nis2_policy_coverage_desc",
        "remediationKey": "compliance.check_nis2_policy_coverage_fix",
        "remediationLink": "admin/compliance/policies",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art21(2)(d)-questionnaire-pack",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(d)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.20",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "DORA",
                "ref": "Art. 30",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 21(2)(d)",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_nis2_questionnaire_pack_title",
        "descriptionKey": "compliance.check_nis2_questionnaire_pack_desc",
        "remediationKey": "compliance.check_nis2_questionnaire_pack_fix",
        "remediationLink": "admin/compliance/soa",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art3-registration",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 3(4)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 3(4)",
        "severity": "high",
        "scope": "global",
        "verification": "attestation",
        "titleKey": "compliance.check_nis2_registration_title",
        "descriptionKey": "compliance.check_nis2_registration_desc",
        "remediationKey": "compliance.check_nis2_registration_fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "NIS2-Art21(2)(a)-risk-analysis",
        "regulation": "NIS2",
        "framework_id": "nis2",
        "frameworks": [
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(a)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "cl. 6.1.2",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.7",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2026-08-15",
        "article": "Art. 21(2)(a)",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_nis2_risk_analysis_title",
        "descriptionKey": "compliance.check_nis2_risk_analysis_desc",
        "remediationKey": "compliance.check_nis2_risk_analysis_fix",
        "remediationLink": "admin/compliance/risks",
        "autoFixId": null
    },
    {
        "check_id": "CRA-AnnexI-II1-sbom",
        "regulation": "CRA",
        "framework_id": "cra",
        "frameworks": [
            {
                "regulation": "CRA",
                "ref": "Annex I Part II(1)",
                "framework_id": "cra",
                "in_force_since": "2027-12-11"
            },
            {
                "regulation": "PLD",
                "ref": "Art. 7(2)(f), Art. 9",
                "framework_id": "pld",
                "in_force_since": "2026-12-09"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.9",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2027-12-11",
        "article": "Annex I Part II(1)",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_cra_sbom_title",
        "descriptionKey": "compliance.check_cra_sbom_desc",
        "remediationKey": "compliance.check_cra_sbom_fix",
        "remediationLink": null,
        "autoFixId": null
    },
    {
        "check_id": "CRA-AnnexI-II5-disclosure-policy",
        "regulation": "CRA",
        "framework_id": "cra",
        "frameworks": [
            {
                "regulation": "CRA",
                "ref": "Annex I Part II(5)",
                "framework_id": "cra",
                "in_force_since": "2027-12-11"
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(e)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.8",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2027-12-11",
        "article": "Annex I Part II(5)",
        "severity": "high",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.check_cra_disclosure_policy_title",
        "descriptionKey": "compliance.check_cra_disclosure_policy_desc",
        "remediationKey": "compliance.check_cra_disclosure_policy_fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": "cra_publish_security_txt_policy"
    },
    {
        "check_id": "CRA-Art13(8)-support-period",
        "regulation": "CRA",
        "framework_id": "cra",
        "frameworks": [
            {
                "regulation": "CRA",
                "ref": "Art. 13(8)",
                "framework_id": "cra",
                "in_force_since": "2027-12-11"
            },
            {
                "regulation": "PLD",
                "ref": "Art. 11(2)(c)",
                "framework_id": "pld",
                "in_force_since": "2026-12-09"
            }
        ],
        "in_force_since": "2027-12-11",
        "article": "Art. 13(8)",
        "severity": "medium",
        "scope": "global",
        "verification": "attestation",
        "titleKey": "compliance.check_cra_support_period_title",
        "descriptionKey": "compliance.check_cra_support_period_desc",
        "remediationKey": "compliance.check_cra_support_period_fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "CRA-Art14-vuln-reporting-clocks",
        "regulation": "CRA",
        "framework_id": "cra",
        "frameworks": [
            {
                "regulation": "CRA",
                "ref": "Art. 14",
                "framework_id": "cra",
                "in_force_since": "2026-09-11"
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 23",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.24",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2026-09-11",
        "article": "Art. 14",
        "severity": "critical",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_cra_vuln_clocks_title",
        "descriptionKey": "compliance.check_cra_vuln_clocks_desc",
        "remediationKey": "compliance.check_cra_vuln_clocks_fix",
        "remediationLink": "admin/compliance/vulnerabilities",
        "autoFixId": null
    },
    {
        "check_id": "DATA_ACT-Art25-exit-procedure",
        "regulation": "DATA_ACT",
        "framework_id": "data_act",
        "frameworks": [
            {
                "regulation": "DATA_ACT",
                "ref": "25(2)(a)",
                "framework_id": "data_act",
                "in_force_since": "2025-09-12"
            },
            {
                "regulation": "DORA",
                "ref": "Art. 28(8)",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            }
        ],
        "in_force_since": "2025-09-12",
        "article": "25(2)(a)",
        "severity": "high",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.check_data_act_exit_procedure_title",
        "descriptionKey": "compliance.check_data_act_exit_procedure_desc",
        "remediationKey": "compliance.check_data_act_exit_procedure_fix",
        "remediationLink": "admin/compliance/policies",
        "autoFixId": null
    },
    {
        "check_id": "DATA_ACT-Art25-notice-period",
        "regulation": "DATA_ACT",
        "framework_id": "data_act",
        "frameworks": [
            {
                "regulation": "DATA_ACT",
                "ref": "25(2)(d)",
                "framework_id": "data_act",
                "in_force_since": "2025-09-12"
            }
        ],
        "in_force_since": "2025-09-12",
        "article": "25(2)(d)",
        "severity": "medium",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.check_data_act_notice_period_title",
        "descriptionKey": "compliance.check_data_act_notice_period_desc",
        "remediationKey": "compliance.check_data_act_notice_period_fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "DATA_ACT-Art30-export-coverage",
        "regulation": "DATA_ACT",
        "framework_id": "data_act",
        "frameworks": [
            {
                "regulation": "DATA_ACT",
                "ref": "30",
                "framework_id": "data_act",
                "in_force_since": "2025-09-12"
            },
            {
                "regulation": "DORA",
                "ref": "Art. 28(8)",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            },
            {
                "regulation": "GDPR",
                "ref": "Art. 20",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2025-09-12",
        "article": "30",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_data_act_export_coverage_title",
        "descriptionKey": "compliance.check_data_act_export_coverage_desc",
        "remediationKey": "compliance.check_data_act_export_coverage_fix",
        "remediationLink": "admin/compliance/portability",
        "autoFixId": null
    },
    {
        "check_id": "DATA_ACT-Art30-machine-readable-formats",
        "regulation": "DATA_ACT",
        "framework_id": "data_act",
        "frameworks": [
            {
                "regulation": "DATA_ACT",
                "ref": "30(3)",
                "framework_id": "data_act",
                "in_force_since": "2025-09-12"
            },
            {
                "regulation": "GDPR",
                "ref": "Art. 20",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2025-09-12",
        "article": "30(3)",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_data_act_formats_title",
        "descriptionKey": "compliance.check_data_act_formats_desc",
        "remediationKey": "compliance.check_data_act_formats_fix",
        "remediationLink": "admin/compliance/portability",
        "autoFixId": null
    },
    {
        "check_id": "PLD-Art9-release-record",
        "regulation": "PLD",
        "framework_id": "pld",
        "frameworks": [
            {
                "regulation": "PLD",
                "ref": "Art. 9",
                "framework_id": "pld",
                "in_force_since": "2026-12-09"
            },
            {
                "regulation": "CRA",
                "ref": "Art. 13",
                "framework_id": "cra",
                "in_force_since": "2027-12-11"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.8.32",
                "framework_id": "iso27001",
                "in_force_since": null
            }
        ],
        "in_force_since": "2026-12-09",
        "article": "Art. 9",
        "severity": "high",
        "scope": "per-source",
        "verification": "automated",
        "titleKey": "compliance.check_pld_release_record_title",
        "descriptionKey": "compliance.check_pld_release_record_desc",
        "remediationKey": "compliance.check_pld_release_record_fix",
        "remediationLink": "studio/solutions",
        "autoFixId": null
    },
    {
        "check_id": "EAA-Art13-accessibility-statement",
        "regulation": "EAA",
        "framework_id": "eaa",
        "frameworks": [
            {
                "regulation": "EAA",
                "ref": "Art. 13(2)",
                "framework_id": "eaa",
                "in_force_since": "2025-06-28"
            }
        ],
        "in_force_since": "2025-06-28",
        "article": "Art. 13(2)",
        "severity": "medium",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.check_eaa_statement_title",
        "descriptionKey": "compliance.check_eaa_statement_desc",
        "remediationKey": "compliance.check_eaa_statement_fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "EAA-Art4-product-surfaces-conformance",
        "regulation": "EAA",
        "framework_id": "eaa",
        "frameworks": [
            {
                "regulation": "EAA",
                "ref": "Art. 4",
                "framework_id": "eaa",
                "in_force_since": "2025-06-28"
            }
        ],
        "in_force_since": "2025-06-28",
        "article": "Art. 4",
        "severity": "high",
        "scope": "global",
        "verification": "hybrid",
        "titleKey": "compliance.check_eaa_product_surfaces_title",
        "descriptionKey": "compliance.check_eaa_product_surfaces_desc",
        "remediationKey": "compliance.check_eaa_product_surfaces_fix",
        "remediationLink": null,
        "autoFixId": null
    },
    {
        "check_id": "EAA-Art4-webpage-a11y",
        "regulation": "EAA",
        "framework_id": "eaa",
        "frameworks": [
            {
                "regulation": "EAA",
                "ref": "Art. 4",
                "framework_id": "eaa",
                "in_force_since": "2025-06-28"
            }
        ],
        "in_force_since": "2025-06-28",
        "article": "Art. 4",
        "severity": "high",
        "scope": "per-source",
        "verification": "automated",
        "titleKey": "compliance.check_eaa_webpage_a11y_title",
        "descriptionKey": "compliance.check_eaa_webpage_a11y_desc",
        "remediationKey": "compliance.check_eaa_webpage_a11y_fix",
        "remediationLink": "admin/studio/webpages",
        "autoFixId": null
    },
    {
        "check_id": "DORA-Art28(3)-register-of-information",
        "regulation": "DORA",
        "framework_id": "dora",
        "frameworks": [
            {
                "regulation": "DORA",
                "ref": "Art. 28(3)",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            },
            {
                "regulation": "GDPR",
                "ref": "Art. 28",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            },
            {
                "regulation": "ISO27001",
                "ref": "A.5.20",
                "framework_id": "iso27001",
                "in_force_since": null
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 21(2)(d)",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            }
        ],
        "in_force_since": "2025-01-17",
        "article": "Art. 28(3)",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_dora_register_title",
        "descriptionKey": "compliance.check_dora_register_desc",
        "remediationKey": "compliance.check_dora_register_fix",
        "remediationLink": "admin/compliance/ropa",
        "autoFixId": null
    },
    {
        "check_id": "DORA-Art30-contract-clauses",
        "regulation": "DORA",
        "framework_id": "dora",
        "frameworks": [
            {
                "regulation": "DORA",
                "ref": "Art. 30(2)",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            }
        ],
        "in_force_since": "2025-01-17",
        "article": "Art. 30(2)",
        "severity": "medium",
        "scope": "global",
        "verification": "attestation",
        "titleKey": "compliance.check_dora_contract_clauses_title",
        "descriptionKey": "compliance.check_dora_contract_clauses_desc",
        "remediationKey": "compliance.check_dora_contract_clauses_fix",
        "remediationLink": "admin/compliance/settings",
        "autoFixId": null
    },
    {
        "check_id": "DORA-Art30-incident-reporting-path",
        "regulation": "DORA",
        "framework_id": "dora",
        "frameworks": [
            {
                "regulation": "DORA",
                "ref": "Art. 30(2)(f)",
                "framework_id": "dora",
                "in_force_since": "2025-01-17"
            },
            {
                "regulation": "NIS2",
                "ref": "Art. 23",
                "framework_id": "nis2",
                "in_force_since": "2026-08-15"
            },
            {
                "regulation": "GDPR",
                "ref": "Art. 33",
                "framework_id": "gdpr",
                "in_force_since": "2018-05-25"
            }
        ],
        "in_force_since": "2025-01-17",
        "article": "Art. 30(2)(f)",
        "severity": "high",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_dora_incident_path_title",
        "descriptionKey": "compliance.check_dora_incident_path_desc",
        "remediationKey": "compliance.check_dora_incident_path_fix",
        "remediationLink": "admin/compliance/incidents",
        "autoFixId": null
    },
    {
        "check_id": "MACHINERY-Art18-safety-component-assessment",
        "regulation": "MACHINERY",
        "framework_id": "machinery",
        "frameworks": [
            {
                "regulation": "MACHINERY",
                "ref": "Art. 18",
                "framework_id": "machinery",
                "in_force_since": "2027-01-20"
            }
        ],
        "in_force_since": "2027-01-20",
        "article": "Art. 18",
        "severity": "high",
        "scope": "per-source",
        "verification": "attestation",
        "titleKey": "compliance.check_machinery_assessment_title",
        "descriptionKey": "compliance.check_machinery_assessment_desc",
        "remediationKey": "compliance.check_machinery_assessment_fix",
        "remediationLink": "admin/compliance/machinery",
        "autoFixId": null
    },
    {
        "check_id": "MACHINERY-Art3-industrial-detection",
        "regulation": "MACHINERY",
        "framework_id": "machinery",
        "frameworks": [
            {
                "regulation": "MACHINERY",
                "ref": "Art. 3(3)",
                "framework_id": "machinery",
                "in_force_since": "2027-01-20"
            }
        ],
        "in_force_since": "2027-01-20",
        "article": "Art. 3(3)",
        "severity": "medium",
        "scope": "global",
        "verification": "automated",
        "titleKey": "compliance.check_machinery_detection_title",
        "descriptionKey": "compliance.check_machinery_detection_desc",
        "remediationKey": "compliance.check_machinery_detection_fix",
        "remediationLink": "admin/compliance/machinery",
        "autoFixId": null
    }
];

export const ISO_CONTROLS = [
    {
        "ref": "A.5.1",
        "key": "a5_1",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_1.title",
        "objectiveKey": "compliance.iso.a5_1.objective"
    },
    {
        "ref": "A.5.2",
        "key": "a5_2",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_2.title",
        "objectiveKey": "compliance.iso.a5_2.objective"
    },
    {
        "ref": "A.5.3",
        "key": "a5_3",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_3.title",
        "objectiveKey": "compliance.iso.a5_3.objective"
    },
    {
        "ref": "A.5.4",
        "key": "a5_4",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_4.title",
        "objectiveKey": "compliance.iso.a5_4.objective"
    },
    {
        "ref": "A.5.5",
        "key": "a5_5",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_5.title",
        "objectiveKey": "compliance.iso.a5_5.objective"
    },
    {
        "ref": "A.5.6",
        "key": "a5_6",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_6.title",
        "objectiveKey": "compliance.iso.a5_6.objective"
    },
    {
        "ref": "A.5.7",
        "key": "a5_7",
        "theme": 5,
        "bucket": "connector",
        "titleKey": "compliance.iso.a5_7.title",
        "objectiveKey": "compliance.iso.a5_7.objective"
    },
    {
        "ref": "A.5.8",
        "key": "a5_8",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_8.title",
        "objectiveKey": "compliance.iso.a5_8.objective"
    },
    {
        "ref": "A.5.9",
        "key": "a5_9",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_9.title",
        "objectiveKey": "compliance.iso.a5_9.objective"
    },
    {
        "ref": "A.5.10",
        "key": "a5_10",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_10.title",
        "objectiveKey": "compliance.iso.a5_10.objective"
    },
    {
        "ref": "A.5.11",
        "key": "a5_11",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_11.title",
        "objectiveKey": "compliance.iso.a5_11.objective"
    },
    {
        "ref": "A.5.12",
        "key": "a5_12",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_12.title",
        "objectiveKey": "compliance.iso.a5_12.objective"
    },
    {
        "ref": "A.5.13",
        "key": "a5_13",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_13.title",
        "objectiveKey": "compliance.iso.a5_13.objective"
    },
    {
        "ref": "A.5.14",
        "key": "a5_14",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_14.title",
        "objectiveKey": "compliance.iso.a5_14.objective"
    },
    {
        "ref": "A.5.15",
        "key": "a5_15",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_15.title",
        "objectiveKey": "compliance.iso.a5_15.objective"
    },
    {
        "ref": "A.5.16",
        "key": "a5_16",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_16.title",
        "objectiveKey": "compliance.iso.a5_16.objective"
    },
    {
        "ref": "A.5.17",
        "key": "a5_17",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_17.title",
        "objectiveKey": "compliance.iso.a5_17.objective"
    },
    {
        "ref": "A.5.18",
        "key": "a5_18",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_18.title",
        "objectiveKey": "compliance.iso.a5_18.objective"
    },
    {
        "ref": "A.5.19",
        "key": "a5_19",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_19.title",
        "objectiveKey": "compliance.iso.a5_19.objective"
    },
    {
        "ref": "A.5.20",
        "key": "a5_20",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_20.title",
        "objectiveKey": "compliance.iso.a5_20.objective"
    },
    {
        "ref": "A.5.21",
        "key": "a5_21",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_21.title",
        "objectiveKey": "compliance.iso.a5_21.objective"
    },
    {
        "ref": "A.5.22",
        "key": "a5_22",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_22.title",
        "objectiveKey": "compliance.iso.a5_22.objective"
    },
    {
        "ref": "A.5.23",
        "key": "a5_23",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_23.title",
        "objectiveKey": "compliance.iso.a5_23.objective"
    },
    {
        "ref": "A.5.24",
        "key": "a5_24",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_24.title",
        "objectiveKey": "compliance.iso.a5_24.objective"
    },
    {
        "ref": "A.5.25",
        "key": "a5_25",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_25.title",
        "objectiveKey": "compliance.iso.a5_25.objective"
    },
    {
        "ref": "A.5.26",
        "key": "a5_26",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_26.title",
        "objectiveKey": "compliance.iso.a5_26.objective"
    },
    {
        "ref": "A.5.27",
        "key": "a5_27",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_27.title",
        "objectiveKey": "compliance.iso.a5_27.objective"
    },
    {
        "ref": "A.5.28",
        "key": "a5_28",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_28.title",
        "objectiveKey": "compliance.iso.a5_28.objective"
    },
    {
        "ref": "A.5.29",
        "key": "a5_29",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_29.title",
        "objectiveKey": "compliance.iso.a5_29.objective"
    },
    {
        "ref": "A.5.30",
        "key": "a5_30",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_30.title",
        "objectiveKey": "compliance.iso.a5_30.objective"
    },
    {
        "ref": "A.5.31",
        "key": "a5_31",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_31.title",
        "objectiveKey": "compliance.iso.a5_31.objective"
    },
    {
        "ref": "A.5.32",
        "key": "a5_32",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_32.title",
        "objectiveKey": "compliance.iso.a5_32.objective"
    },
    {
        "ref": "A.5.33",
        "key": "a5_33",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_33.title",
        "objectiveKey": "compliance.iso.a5_33.objective"
    },
    {
        "ref": "A.5.34",
        "key": "a5_34",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_34.title",
        "objectiveKey": "compliance.iso.a5_34.objective"
    },
    {
        "ref": "A.5.35",
        "key": "a5_35",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_35.title",
        "objectiveKey": "compliance.iso.a5_35.objective"
    },
    {
        "ref": "A.5.36",
        "key": "a5_36",
        "theme": 5,
        "bucket": "auto",
        "titleKey": "compliance.iso.a5_36.title",
        "objectiveKey": "compliance.iso.a5_36.objective"
    },
    {
        "ref": "A.5.37",
        "key": "a5_37",
        "theme": 5,
        "bucket": "attest",
        "titleKey": "compliance.iso.a5_37.title",
        "objectiveKey": "compliance.iso.a5_37.objective"
    },
    {
        "ref": "A.6.1",
        "key": "a6_1",
        "theme": 6,
        "bucket": "attest",
        "titleKey": "compliance.iso.a6_1.title",
        "objectiveKey": "compliance.iso.a6_1.objective"
    },
    {
        "ref": "A.6.2",
        "key": "a6_2",
        "theme": 6,
        "bucket": "attest",
        "titleKey": "compliance.iso.a6_2.title",
        "objectiveKey": "compliance.iso.a6_2.objective"
    },
    {
        "ref": "A.6.3",
        "key": "a6_3",
        "theme": 6,
        "bucket": "attest",
        "titleKey": "compliance.iso.a6_3.title",
        "objectiveKey": "compliance.iso.a6_3.objective"
    },
    {
        "ref": "A.6.4",
        "key": "a6_4",
        "theme": 6,
        "bucket": "attest",
        "titleKey": "compliance.iso.a6_4.title",
        "objectiveKey": "compliance.iso.a6_4.objective"
    },
    {
        "ref": "A.6.5",
        "key": "a6_5",
        "theme": 6,
        "bucket": "auto",
        "titleKey": "compliance.iso.a6_5.title",
        "objectiveKey": "compliance.iso.a6_5.objective"
    },
    {
        "ref": "A.6.6",
        "key": "a6_6",
        "theme": 6,
        "bucket": "attest",
        "titleKey": "compliance.iso.a6_6.title",
        "objectiveKey": "compliance.iso.a6_6.objective"
    },
    {
        "ref": "A.6.7",
        "key": "a6_7",
        "theme": 6,
        "bucket": "attest",
        "titleKey": "compliance.iso.a6_7.title",
        "objectiveKey": "compliance.iso.a6_7.objective"
    },
    {
        "ref": "A.6.8",
        "key": "a6_8",
        "theme": 6,
        "bucket": "auto",
        "titleKey": "compliance.iso.a6_8.title",
        "objectiveKey": "compliance.iso.a6_8.objective"
    },
    {
        "ref": "A.7.1",
        "key": "a7_1",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_1.title",
        "objectiveKey": "compliance.iso.a7_1.objective"
    },
    {
        "ref": "A.7.2",
        "key": "a7_2",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_2.title",
        "objectiveKey": "compliance.iso.a7_2.objective"
    },
    {
        "ref": "A.7.3",
        "key": "a7_3",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_3.title",
        "objectiveKey": "compliance.iso.a7_3.objective"
    },
    {
        "ref": "A.7.4",
        "key": "a7_4",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_4.title",
        "objectiveKey": "compliance.iso.a7_4.objective"
    },
    {
        "ref": "A.7.5",
        "key": "a7_5",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_5.title",
        "objectiveKey": "compliance.iso.a7_5.objective"
    },
    {
        "ref": "A.7.6",
        "key": "a7_6",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_6.title",
        "objectiveKey": "compliance.iso.a7_6.objective"
    },
    {
        "ref": "A.7.7",
        "key": "a7_7",
        "theme": 7,
        "bucket": "attest",
        "titleKey": "compliance.iso.a7_7.title",
        "objectiveKey": "compliance.iso.a7_7.objective"
    },
    {
        "ref": "A.7.8",
        "key": "a7_8",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_8.title",
        "objectiveKey": "compliance.iso.a7_8.objective"
    },
    {
        "ref": "A.7.9",
        "key": "a7_9",
        "theme": 7,
        "bucket": "connector",
        "titleKey": "compliance.iso.a7_9.title",
        "objectiveKey": "compliance.iso.a7_9.objective"
    },
    {
        "ref": "A.7.10",
        "key": "a7_10",
        "theme": 7,
        "bucket": "connector",
        "titleKey": "compliance.iso.a7_10.title",
        "objectiveKey": "compliance.iso.a7_10.objective"
    },
    {
        "ref": "A.7.11",
        "key": "a7_11",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_11.title",
        "objectiveKey": "compliance.iso.a7_11.objective"
    },
    {
        "ref": "A.7.12",
        "key": "a7_12",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_12.title",
        "objectiveKey": "compliance.iso.a7_12.objective"
    },
    {
        "ref": "A.7.13",
        "key": "a7_13",
        "theme": 7,
        "bucket": "physical",
        "titleKey": "compliance.iso.a7_13.title",
        "objectiveKey": "compliance.iso.a7_13.objective"
    },
    {
        "ref": "A.7.14",
        "key": "a7_14",
        "theme": 7,
        "bucket": "attest",
        "titleKey": "compliance.iso.a7_14.title",
        "objectiveKey": "compliance.iso.a7_14.objective"
    },
    {
        "ref": "A.8.1",
        "key": "a8_1",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_1.title",
        "objectiveKey": "compliance.iso.a8_1.objective"
    },
    {
        "ref": "A.8.2",
        "key": "a8_2",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_2.title",
        "objectiveKey": "compliance.iso.a8_2.objective"
    },
    {
        "ref": "A.8.3",
        "key": "a8_3",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_3.title",
        "objectiveKey": "compliance.iso.a8_3.objective"
    },
    {
        "ref": "A.8.4",
        "key": "a8_4",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_4.title",
        "objectiveKey": "compliance.iso.a8_4.objective"
    },
    {
        "ref": "A.8.5",
        "key": "a8_5",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_5.title",
        "objectiveKey": "compliance.iso.a8_5.objective"
    },
    {
        "ref": "A.8.6",
        "key": "a8_6",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_6.title",
        "objectiveKey": "compliance.iso.a8_6.objective"
    },
    {
        "ref": "A.8.7",
        "key": "a8_7",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_7.title",
        "objectiveKey": "compliance.iso.a8_7.objective"
    },
    {
        "ref": "A.8.8",
        "key": "a8_8",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_8.title",
        "objectiveKey": "compliance.iso.a8_8.objective"
    },
    {
        "ref": "A.8.9",
        "key": "a8_9",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_9.title",
        "objectiveKey": "compliance.iso.a8_9.objective"
    },
    {
        "ref": "A.8.10",
        "key": "a8_10",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_10.title",
        "objectiveKey": "compliance.iso.a8_10.objective"
    },
    {
        "ref": "A.8.11",
        "key": "a8_11",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_11.title",
        "objectiveKey": "compliance.iso.a8_11.objective"
    },
    {
        "ref": "A.8.12",
        "key": "a8_12",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_12.title",
        "objectiveKey": "compliance.iso.a8_12.objective"
    },
    {
        "ref": "A.8.13",
        "key": "a8_13",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_13.title",
        "objectiveKey": "compliance.iso.a8_13.objective"
    },
    {
        "ref": "A.8.14",
        "key": "a8_14",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_14.title",
        "objectiveKey": "compliance.iso.a8_14.objective"
    },
    {
        "ref": "A.8.15",
        "key": "a8_15",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_15.title",
        "objectiveKey": "compliance.iso.a8_15.objective"
    },
    {
        "ref": "A.8.16",
        "key": "a8_16",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_16.title",
        "objectiveKey": "compliance.iso.a8_16.objective"
    },
    {
        "ref": "A.8.17",
        "key": "a8_17",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_17.title",
        "objectiveKey": "compliance.iso.a8_17.objective"
    },
    {
        "ref": "A.8.18",
        "key": "a8_18",
        "theme": 8,
        "bucket": "attest",
        "titleKey": "compliance.iso.a8_18.title",
        "objectiveKey": "compliance.iso.a8_18.objective"
    },
    {
        "ref": "A.8.19",
        "key": "a8_19",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_19.title",
        "objectiveKey": "compliance.iso.a8_19.objective"
    },
    {
        "ref": "A.8.20",
        "key": "a8_20",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_20.title",
        "objectiveKey": "compliance.iso.a8_20.objective"
    },
    {
        "ref": "A.8.21",
        "key": "a8_21",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_21.title",
        "objectiveKey": "compliance.iso.a8_21.objective"
    },
    {
        "ref": "A.8.22",
        "key": "a8_22",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_22.title",
        "objectiveKey": "compliance.iso.a8_22.objective"
    },
    {
        "ref": "A.8.23",
        "key": "a8_23",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_23.title",
        "objectiveKey": "compliance.iso.a8_23.objective"
    },
    {
        "ref": "A.8.24",
        "key": "a8_24",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_24.title",
        "objectiveKey": "compliance.iso.a8_24.objective"
    },
    {
        "ref": "A.8.25",
        "key": "a8_25",
        "theme": 8,
        "bucket": "attest",
        "titleKey": "compliance.iso.a8_25.title",
        "objectiveKey": "compliance.iso.a8_25.objective"
    },
    {
        "ref": "A.8.26",
        "key": "a8_26",
        "theme": 8,
        "bucket": "attest",
        "titleKey": "compliance.iso.a8_26.title",
        "objectiveKey": "compliance.iso.a8_26.objective"
    },
    {
        "ref": "A.8.27",
        "key": "a8_27",
        "theme": 8,
        "bucket": "attest",
        "titleKey": "compliance.iso.a8_27.title",
        "objectiveKey": "compliance.iso.a8_27.objective"
    },
    {
        "ref": "A.8.28",
        "key": "a8_28",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_28.title",
        "objectiveKey": "compliance.iso.a8_28.objective"
    },
    {
        "ref": "A.8.29",
        "key": "a8_29",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_29.title",
        "objectiveKey": "compliance.iso.a8_29.objective"
    },
    {
        "ref": "A.8.30",
        "key": "a8_30",
        "theme": 8,
        "bucket": "attest",
        "titleKey": "compliance.iso.a8_30.title",
        "objectiveKey": "compliance.iso.a8_30.objective"
    },
    {
        "ref": "A.8.31",
        "key": "a8_31",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_31.title",
        "objectiveKey": "compliance.iso.a8_31.objective"
    },
    {
        "ref": "A.8.32",
        "key": "a8_32",
        "theme": 8,
        "bucket": "connector",
        "titleKey": "compliance.iso.a8_32.title",
        "objectiveKey": "compliance.iso.a8_32.objective"
    },
    {
        "ref": "A.8.33",
        "key": "a8_33",
        "theme": 8,
        "bucket": "auto",
        "titleKey": "compliance.iso.a8_33.title",
        "objectiveKey": "compliance.iso.a8_33.objective"
    },
    {
        "ref": "A.8.34",
        "key": "a8_34",
        "theme": 8,
        "bucket": "attest",
        "titleKey": "compliance.iso.a8_34.title",
        "objectiveKey": "compliance.iso.a8_34.objective"
    }
];

export const ISO_THEMES = {
    "5": "organizational",
    "6": "people",
    "7": "physical",
    "8": "technological"
};

export const ISO_CONNECTORS = [
    {
        "id": "afas",
        "titleKey": "compliance.connector.afas.title",
        "descKey": "compliance.connector.afas.desc",
        "covered_controls": [
            "A.6.1",
            "A.6.5"
        ],
        "checks": [
            "ISO27001-A.6.5-offboarding-feed"
        ],
        "credential": {
            "provider": "afas",
            "kinds": [
                "api_key"
            ]
        },
        "settings_hint": "base_url: \"https://12345.rest.afas.online/ProfitRestServices\", connector: \"Profit_Employees\""
    },
    {
        "id": "github",
        "titleKey": "compliance.connector.github.title",
        "descKey": "compliance.connector.github.desc",
        "covered_controls": [
            "A.8.4",
            "A.8.8",
            "A.8.28",
            "A.8.29",
            "A.8.31",
            "A.8.32"
        ],
        "checks": [
            "ISO27001-A.8.8-vuln-mgmt",
            "ISO27001-A.8.4-source-protection",
            "ISO27001-A.8.28-secure-coding",
            "ISO27001-A.8.32-change-management"
        ],
        "credential": {
            "provider": "github",
            "kinds": [
                "bearer",
                "api_key"
            ]
        },
        "settings_hint": "repos: [\"owner/repo\"]"
    },
    {
        "id": "google-workspace",
        "titleKey": "compliance.connector.google_workspace.title",
        "descKey": "compliance.connector.google_workspace.desc",
        "covered_controls": [
            "A.5.16",
            "A.5.18",
            "A.8.2"
        ],
        "checks": [
            "ISO27001-A.5.16-identity-hygiene"
        ],
        "credential": {
            "provider": "google-workspace",
            "kinds": [
                "oauth2_cc"
            ]
        },
        "settings_hint": "customer: \"my_customer\" (default) or domain: \"acme.nl\""
    },
    {
        "id": "mail-security",
        "titleKey": "compliance.connector.mail_security.title",
        "descKey": "compliance.connector.mail_security.desc",
        "covered_controls": [
            "A.5.14",
            "A.8.26"
        ],
        "checks": [
            "ISO27001-A.5.14-mail-security"
        ],
        "credential": null,
        "settings_hint": "domain: \"beeflow.nl\", dkim_selectors: [\"mandrill\"]"
    },
    {
        "id": "microsoft-entra",
        "titleKey": "compliance.connector.microsoft_entra.title",
        "descKey": "compliance.connector.microsoft_entra.desc",
        "covered_controls": [
            "A.5.16",
            "A.5.18",
            "A.8.2"
        ],
        "checks": [
            "ISO27001-A.5.16-identity-hygiene"
        ],
        "credential": {
            "provider": "microsoft-entra",
            "kinds": [
                "oauth2_cc"
            ]
        },
        "settings_hint": "no settings — tenant comes from the linked credential"
    },
    {
        "id": "nextcloud",
        "titleKey": "compliance.connector.nextcloud.title",
        "descKey": "compliance.connector.nextcloud.desc",
        "covered_controls": [
            "A.8.19",
            "A.8.8"
        ],
        "checks": [
            "ISO27001-A.8.19-workplace-software"
        ],
        "credential": {
            "provider": "nextcloud",
            "kinds": [
                "basic"
            ]
        },
        "settings_hint": "base_url: \"https://cloud.acme.nl\""
    },
    {
        "id": "openobserve",
        "titleKey": "compliance.connector.openobserve.title",
        "descKey": "compliance.connector.openobserve.desc",
        "covered_controls": [
            "A.8.16",
            "A.8.17"
        ],
        "checks": [
            "ISO27001-A.8.16-monitoring"
        ],
        "credential": {
            "provider": "openobserve",
            "kinds": [
                "basic",
                "bearer"
            ]
        },
        "settings_hint": "base_url: \"https://observe.example.com\", org: \"default\""
    },
    {
        "id": "scaleway",
        "titleKey": "compliance.connector.scaleway.title",
        "descKey": "compliance.connector.scaleway.desc",
        "covered_controls": [
            "A.8.13",
            "A.8.14",
            "A.8.20",
            "A.8.22"
        ],
        "checks": [
            "ISO27001-A.8.13-backups",
            "ISO27001-A.8.20-network-exposure"
        ],
        "credential": {
            "provider": "scaleway",
            "kinds": [
                "api_key"
            ]
        },
        "settings_hint": "region: \"nl-ams\", project_id: \"...\""
    },
    {
        "id": "tls-endpoints",
        "titleKey": "compliance.connector.tls_endpoints.title",
        "descKey": "compliance.connector.tls_endpoints.desc",
        "covered_controls": [
            "A.8.24"
        ],
        "checks": [
            "ISO27001-A.8.24-tls-endpoints"
        ],
        "credential": null,
        "settings_hint": "endpoints: [\"beeflow.nl\", \"app.beeflow.nl\"]"
    },
    {
        "id": "youtrack",
        "titleKey": "compliance.connector.youtrack.title",
        "descKey": "compliance.connector.youtrack.desc",
        "covered_controls": [
            "A.8.32"
        ],
        "checks": [
            "ISO27001-A.8.32-ticketed-changes"
        ],
        "credential": {
            "provider": "youtrack",
            "kinds": [
                "bearer"
            ]
        },
        "settings_hint": "base_url: \"https://acme.youtrack.cloud\", project: \"OPS\""
    }
];
