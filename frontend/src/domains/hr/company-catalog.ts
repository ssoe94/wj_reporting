// Generated from backend/analytics/hr_company_structure.py; check-hr.py verifies parity.
import type { HrDepartment } from './types.ts';

const catalog = {
  "classification": {
    "version": "wj-company-structure.v1",
    "nodes": [
      {
        "id": "board-chairman",
        "name": "董事长",
        "parent_id": null,
        "function": "董事长"
      },
      {
        "id": "business-gm",
        "name": "业务管理总经理",
        "parent_id": null,
        "function": "业务管理总经理"
      },
      {
        "id": "technical-gm",
        "name": "生产技术总经理",
        "parent_id": null,
        "function": "生产技术总经理"
      },
      {
        "id": "quality",
        "name": "品质管理",
        "parent_id": null,
        "function": "品质管理"
      },
      {
        "id": "quality-patrol",
        "name": "巡检",
        "parent_id": "quality",
        "function": "巡检"
      },
      {
        "id": "quality-oqc",
        "name": "OQC",
        "parent_id": "quality",
        "function": "OQC"
      },
      {
        "id": "quality-cs",
        "name": "CS",
        "parent_id": "quality",
        "function": "CS"
      },
      {
        "id": "injection",
        "name": "注塑管理",
        "parent_id": null,
        "function": "注塑管理"
      },
      {
        "id": "injection-operator",
        "name": "操作工",
        "parent_id": "injection",
        "function": "操作工"
      },
      {
        "id": "injection-mold-change",
        "name": "换模工",
        "parent_id": "injection",
        "function": "换模工"
      },
      {
        "id": "injection-5s",
        "name": "5S",
        "parent_id": "injection",
        "function": "5S"
      },
      {
        "id": "injection-feeding",
        "name": "加料/入库",
        "parent_id": "injection",
        "function": "加料/入库"
      },
      {
        "id": "machining",
        "name": "加工管理",
        "parent_id": null,
        "function": "加工管理"
      },
      {
        "id": "machining-operator",
        "name": "操作工",
        "parent_id": "machining",
        "function": "操作工"
      },
      {
        "id": "sales",
        "name": "营业管理",
        "parent_id": null,
        "function": "营业管理"
      },
      {
        "id": "sales-warehouse",
        "name": "仓库/物流",
        "parent_id": "sales",
        "function": "仓库/物流"
      },
      {
        "id": "sales-cs",
        "name": "CS",
        "parent_id": "sales",
        "function": "CS"
      },
      {
        "id": "sales-support",
        "name": "辅助",
        "parent_id": "sales",
        "function": "辅助"
      },
      {
        "id": "materials",
        "name": "资材管理",
        "parent_id": null,
        "function": "资材管理"
      },
      {
        "id": "materials-raw",
        "name": "原材料",
        "parent_id": "materials",
        "function": "原材料"
      },
      {
        "id": "materials-secondary",
        "name": "副资材",
        "parent_id": "materials",
        "function": "副资材"
      },
      {
        "id": "materials-crushing",
        "name": "粉碎",
        "parent_id": "materials",
        "function": "粉碎"
      },
      {
        "id": "mold-maintenance",
        "name": "模具/公务",
        "parent_id": null,
        "function": "模具/公务"
      },
      {
        "id": "mold-worker",
        "name": "模具工",
        "parent_id": "mold-maintenance",
        "function": "模具工"
      },
      {
        "id": "maintenance-worker",
        "name": "公务员工",
        "parent_id": "mold-maintenance",
        "function": "公务员工"
      },
      {
        "id": "administration",
        "name": "管理部门",
        "parent_id": null,
        "function": "管理部门"
      },
      {
        "id": "admin-finance",
        "name": "财务",
        "parent_id": "administration",
        "function": "财务"
      },
      {
        "id": "admin-hr",
        "name": "人事/总务",
        "parent_id": "administration",
        "function": "人事/总务"
      }
    ],
    "leaders": [
      {
        "id": "board-chairman",
        "label": "董事长"
      },
      {
        "id": "business-gm",
        "label": "业务管理总经理"
      },
      {
        "id": "technical-gm",
        "label": "生产技术总经理"
      }
    ],
    "groups": [
      {
        "id": "quality",
        "label": "品质管理",
        "row": 1,
        "column": 1,
        "children": [
          "quality-patrol",
          "quality-oqc",
          "quality-cs"
        ]
      },
      {
        "id": "injection",
        "label": "注塑管理",
        "row": 1,
        "column": 2,
        "children": [
          "injection-operator",
          "injection-mold-change",
          "injection-5s",
          "injection-feeding"
        ]
      },
      {
        "id": "machining",
        "label": "加工管理",
        "row": 1,
        "column": 3,
        "children": [
          "machining-operator"
        ]
      },
      {
        "id": "sales",
        "label": "营业管理",
        "row": 1,
        "column": 4,
        "children": [
          "sales-warehouse",
          "sales-cs",
          "sales-support"
        ]
      },
      {
        "id": "materials",
        "label": "资材管理",
        "row": 1,
        "column": 5,
        "children": [
          "materials-raw",
          "materials-secondary",
          "materials-crushing"
        ]
      },
      {
        "id": "mold-maintenance",
        "label": "模具/公务",
        "row": 2,
        "column": 2,
        "children": [
          "mold-worker",
          "maintenance-worker"
        ]
      },
      {
        "id": "administration",
        "label": "管理部门",
        "row": 2,
        "column": 3,
        "children": [
          "admin-finance",
          "admin-hr"
        ]
      }
    ]
  },
  "organization": {
    "nodes": [
      {
        "id": "chairman",
        "label": "CHAIRMAN",
        "name": "",
        "parent_id": null
      },
      {
        "id": "qa",
        "label": "QA Team",
        "name": "",
        "parent_id": "chairman"
      },
      {
        "id": "business",
        "label": "业务管理\n副总经理",
        "name": "",
        "parent_id": "chairman"
      },
      {
        "id": "technical",
        "label": "生产技术\n副总经理",
        "name": "",
        "parent_id": "chairman"
      },
      {
        "id": "esh",
        "label": "ESH管理",
        "name": "",
        "parent_id": "business"
      },
      {
        "id": "office",
        "label": "办公室主任",
        "name": "",
        "parent_id": "business"
      },
      {
        "id": "sales-operations",
        "label": "销售运营部长",
        "name": "",
        "parent_id": "business"
      },
      {
        "id": "development",
        "label": "开发研究",
        "name": "",
        "parent_id": "technical"
      },
      {
        "id": "production",
        "label": "生产部长",
        "name": "",
        "parent_id": "technical"
      },
      {
        "id": "hr",
        "label": "总务/人事",
        "name": "",
        "parent_id": "office"
      },
      {
        "id": "finance",
        "label": "财务",
        "name": "",
        "parent_id": "office"
      },
      {
        "id": "production-management",
        "label": "生产管理",
        "name": "",
        "parent_id": "sales-operations"
      },
      {
        "id": "purchasing",
        "label": "采购",
        "name": "",
        "parent_id": "sales-operations"
      },
      {
        "id": "injection",
        "label": "注塑",
        "name": "",
        "parent_id": "production"
      },
      {
        "id": "machining",
        "label": "加工",
        "name": "",
        "parent_id": "production"
      },
      {
        "id": "mold",
        "label": "模具",
        "name": "",
        "parent_id": "production"
      },
      {
        "id": "maintenance",
        "label": "公务",
        "name": "",
        "parent_id": "production"
      }
    ],
    "edges": [
      {
        "from": "chairman",
        "to": "qa"
      },
      {
        "from": "chairman",
        "to": "business"
      },
      {
        "from": "chairman",
        "to": "technical"
      },
      {
        "from": "business",
        "to": "esh"
      },
      {
        "from": "business",
        "to": "office"
      },
      {
        "from": "business",
        "to": "sales-operations"
      },
      {
        "from": "technical",
        "to": "development"
      },
      {
        "from": "technical",
        "to": "production"
      },
      {
        "from": "office",
        "to": "hr"
      },
      {
        "from": "office",
        "to": "finance"
      },
      {
        "from": "sales-operations",
        "to": "production-management"
      },
      {
        "from": "sales-operations",
        "to": "purchasing"
      },
      {
        "from": "production",
        "to": "injection"
      },
      {
        "from": "production",
        "to": "machining"
      },
      {
        "from": "production",
        "to": "mold"
      },
      {
        "from": "production",
        "to": "maintenance"
      }
    ]
  }
};

export const COMPANY_CLASSIFICATION = { ...catalog.classification, nodes: catalog.classification.nodes as HrDepartment[] };
export const COMPANY_ORGANIZATION = catalog.organization;
