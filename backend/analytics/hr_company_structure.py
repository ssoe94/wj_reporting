"""User-supplied functional cost cells and separate reporting-chart reference.

No employee is assigned by name, source department, or job title.
"""
import json
from copy import deepcopy

CATALOG_VERSION = 'wj-company-structure.v2'
LEADERS = [
    {'id': 'board-chairman', 'label': '董事长'},
    {'id': 'business-gm', 'label': '李宰荣 总经理'},
    {'id': 'technical-gm', 'label': '刘明亮 总经理'},
]
GROUP_DEFINITIONS = [
    ('quality', '品质管理', 1, 1, [('quality-patrol', '巡检'), ('quality-oqc', '进出货检验'), ('quality-cs', 'CS')]),
    ('injection', '注塑管理', 1, 2, [('injection-operator', '操作工'), ('injection-mold-change', '换模工'), ('injection-5s', '5S'), ('injection-feeding', '加料/入库')]),
    ('machining', '加工管理', 1, 3, [('machining-operator', '操作工')]),
    ('sales', '营业管理', 1, 4, [('sales-warehouse', '仓库/物流'), ('sales-cs', 'CS'), ('sales-support', '辅助')]),
    ('materials', '资材管理', 1, 5, [('materials-raw', '原材料'), ('materials-secondary', '副资材'), ('materials-crushing', '粉碎')]),
    ('mold-maintenance', '模具/公务', 2, 2, [('mold-worker', '模具工'), ('maintenance-worker', '公务员工')]),
    ('administration', '管理部门', 2, 3, [('admin-finance', '财务'), ('admin-hr', '人事/总务')]),
    ('development', '开发管理', 2, 4, [('development-staff', '开发人员')]),
]
COMPANY_DEPARTMENTS = [{'id': item['id'], 'name': item['label'], 'parent_id': None, 'function': item['label']} for item in LEADERS]
for group_id, label, _, _, children in GROUP_DEFINITIONS:
    COMPANY_DEPARTMENTS.append({'id': group_id, 'name': label, 'parent_id': None, 'function': label})
    COMPANY_DEPARTMENTS.extend({'id': cell_id, 'name': name, 'parent_id': group_id, 'function': name} for cell_id, name in children)

ORGANIZATION_NODES = [
    ('chairman', 'CHAIRMAN', '李泓九', None), ('qa', 'QA Team', '', 'chairman'),
    ('business', '业务管理\n副总经理', '李宰荣', 'chairman'), ('technical', '生产技术\n副总经理', '刘明亮', 'chairman'),
    ('esh', 'ESH管理', '余学府', 'business'), ('office', '办公室主任', '曹娅娟', 'business'),
    ('sales-operations', '销售运营部长', '徐林', 'business'), ('development', '开发研究', '田永松', 'technical'),
    ('production', '生产部长', '许超杰', 'technical'), ('hr', '总务/人事', '', 'office'),
    ('finance', '财务', '', 'office'), ('production-management', '生产管理', '', 'sales-operations'),
    ('purchasing', '采购', '', 'sales-operations'), ('injection', '注塑', '', 'production'),
    ('machining', '加工', '', 'production'), ('mold', '模具', '', 'production'), ('maintenance', '公务', '', 'production'),
]


def company_catalog():
    nodes = [{'id': node_id, 'label': label, 'name': name, 'parent_id': parent} for node_id, label, name, parent in ORGANIZATION_NODES]
    return {
        'classification': {
            'version': CATALOG_VERSION, 'nodes': COMPANY_DEPARTMENTS, 'leaders': LEADERS,
            'groups': [{'id': group_id, 'label': label, 'row': row, 'column': column, 'children': [item[0] for item in children]} for group_id, label, row, column, children in GROUP_DEFINITIONS],
        },
        'organization': {'nodes': nodes, 'edges': [{'from': node['parent_id'], 'to': node['id']} for node in nodes if node['parent_id']]},
    }


def frontend_catalog_source():
    public = deepcopy(company_catalog())
    labels = {'board-chairman': '董事长', 'business-gm': '业务管理总经理', 'technical-gm': '生产技术总经理'}
    for node in public['classification']['nodes']:
        if node['id'] in labels:
            node['name'] = labels[node['id']]
            node['function'] = labels[node['id']]
    for node in public['classification']['leaders']:
        node['label'] = labels[node['id']]
    for node in public['organization']['nodes']:
        node['name'] = ''
    payload = json.dumps(public, ensure_ascii=False, indent=2)
    return "// Generated from backend/analytics/hr_company_structure.py; check-hr.py verifies parity.\n" + "import type { HrDepartment } from './types.ts';\n\nconst catalog = " + payload + ";\n\nexport const COMPANY_CLASSIFICATION = { ...catalog.classification, nodes: catalog.classification.nodes as HrDepartment[] };\nexport const COMPANY_ORGANIZATION = catalog.organization;\n"
