# -*- coding: utf-8 -*-
"""就地重写 _r211-migrate.py 的分组策略：单顶层组内嵌「管理与设置」子组。
原版是与生产同名的双组（日常业务/管理与设置）各挂 2~3 页；实测本地渲染层
在"多个顶层 group"下只渲染第一个（见 DEV 记录），故改为唯一顶层组内的嵌套子组。
"""
import io, re, sys

p = 'scripts/_r211-migrate.py'
s = io.open(p, encoding='utf-8').read()

OLD_PAGES = '''PAGES = {
    GROUP_DAILY: ["售后服务工作台", "我的门店工单"],          # 4 角色
    GROUP_ADMIN: ["门店报修入口", "历史数据导入", "历史售后档案"],  # 6 角色
}
BASE_GROUP = "售后工单"'''

NEW_PAGES = '''# 【2026-11-17 修订】改为：唯一顶层组 + 组内嵌套「管理与设置」子组。
# 理由：本地实测 NocoBase 2.2.15 的混排布局（header+sider）在存在多个顶层 group 时，
# 只把第一个 group 渲染成可折叠组，其余顶层 group 被当成普通 item 或顶栏项 ——
# 也就是"两个并列分组"这条路在当前版本渲染层走不通。用户已选择"只建一个组"的方案，
# 这里落实为：保留生产原有的顶层组（标题可改），在其内部嵌入一个「管理与设置」子组。
PAGES = {
    GROUP_ADMIN: ["门店报修入口", "历史数据导入", "历史售后档案"],  # 6 角色
}
BASE_GROUP = "售后工单"
DAILY_TITLES = ["售后服务工作台", "我的门店工单"]   # 留在顶层组直属，不再单独成组'''

assert OLD_PAGES in s, 'anchor PAGES block not found'
s = s.replace(OLD_PAGES, NEW_PAGES)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched PAGES block OK')
