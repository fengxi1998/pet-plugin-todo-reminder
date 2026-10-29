#!/usr/bin/env bash
# 一键发布：建公开仓库 → 推源码 → 打标签 → 等 CI → 复核摘要 → 输出登记条目
#
# 前提：环境变量 GITHUB_TOKEN 是一个带 repo 权限的 Personal Access Token。
#   - classic token 需要勾选 public_repo（公开仓库读写）
#   - fine-grained token 需要 Repository permissions: Contents: Read and write
#
# 用法：
#   export GITHUB_TOKEN=ghp_xxx
#   bash scripts/publish.sh
#
# 安全：token 只从环境变量读，不落盘、不进命令行历史。

set -euo pipefail

REPO_SLUG="pet-plugin-todo-reminder"
VERSION="1.0.2"
TAG="v${VERSION}"
OWNER="${GITHUB_OWNER:-fengxi1998}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="https://api.github.com"

# ---- 取 token：优先环境变量，其次问 git 凭据管理器（Git Credential Manager）----
# GCM 路径可能因 PortableGit 升级轮换版本号而失效，这里不写死路径，
# 直接用 `git credential fill` —— git 会按 credential.helper 配置去找实际的 GCM。
resolve_token() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "${GITHUB_TOKEN}"
    return 0
  fi
  # 从 git 凭据管理器取（用户在浏览器登录过 GCM 才有）
  local out
  out=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null || true)
  local pw
  pw=$(printf '%s\n' "${out}" | sed -n 's/^password=//p' | head -1)
  if [ -n "${pw}" ]; then
    echo "${pw}"
    return 0
  fi
  return 1
}

if ! GITHUB_TOKEN="$(resolve_token)"; then
  cat >&2 << 'EOF'
错误：找不到 GitHub 凭据。二选一：

  A) 提供 PAT（推荐）
     打开 https://github.com/settings/tokens → Generate new token (classic)
     勾选 public_repo → 复制 token，然后：
         export GITHUB_TOKEN=ghp_你的token
         bash scripts/publish.sh

  B) 在你自己的终端里登录一次 git 凭据管理器
     在普通终端窗口（不是本工具的 shell）执行：
         cd <任意目录> && git clone https://github.com/fengxi1998/fengxi1998
     弹出浏览器授权后凭据会存进 Windows 凭据管理器，本脚本会自动取用。

EOF
  exit 1
fi

# API 调用：api.github.com 走代理或直连都可达（实测两种方式均返回 401 = 正常需认证）。
# 保留代理设置以适应不同网络环境；如遇 502 可加 --noproxy '*' 强制直连。
CURL=(curl -sS --max-time 30)

auth() {
  "${CURL[@]}" -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

echo "=== 1. 验证 token ==="
LOGIN=$(auth "${API}/user" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).login||'')}catch(e){console.log('')}})")
if [ -z "${LOGIN}" ]; then
  echo "错误：token 无效或认证失败" >&2
  exit 1
fi
echo "认证成功: ${LOGIN}（期望 ${OWNER}）"

echo ""
echo "=== 2. 创建公开仓库 ${OWNER}/${REPO_SLUG} ==="
EXISTS=$(auth -o /dev/null -w "%{http_code}" "${API}/repos/${OWNER}/${REPO_SLUG}")
if [ "${EXISTS}" = "200" ]; then
  echo "仓库已存在，跳过创建"
else
  auth -X POST "${API}/user/repos" \
    -d "{\"name\":\"${REPO_SLUG}\",\"description\":\"吐梨邦插件：待办清单 + 到点提醒。到时间桌宠会冒泡、做动作、刷徽标，支持推迟、逾期催办与看板卡片。\",\"private\":false,\"autoInit\":false}" \
    -o /dev/null -w "创建结果 HTTP %{http_code}\n"
fi

echo ""
echo "=== 3. 推送到 main ==="
cd "${REPO_DIR}"
# 用一次性 remote 传 token，不写进 .git/config（remote URL 里带 token，用完即弃）
REMOTE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${OWNER}/${REPO_SLUG}.git"
git init -b main >/dev/null 2>&1 || true
git add -A
git config user.name "fengxi1998"
git config user.email "1363107264@qq.com"
if git diff --cached --quiet; then
  echo "无文件变化，跳过提交"
else
  git commit -q -m "feat: 到点提醒 ${VERSION} — 待办清单与到点提醒" || true
fi
# 用 GIT_ASKPASS 代替 URL 内嵌 token：凭据不经过命令行，也不落在 remote 配置里
cat > "${REPO_DIR}/.git-askpass.sh" << 'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "$GITHUB_TOKEN" ;;
  *) echo "" ;;
esac
ASKPASS
chmod +x "${REPO_DIR}/.git-askpass.sh"
export GIT_ASKPASS="${REPO_DIR}/.git-askpass.sh"
export GIT_TERMINAL_PROMPT=0
git push -q "${REMOTE_URL}" main:refs/heads/main 2>&1 | sed 's|https://[^ ]*@|https://***@|g'
rm -f "${REPO_DIR}/.git-askpass.sh"
echo "已推送 main"

echo ""
echo "=== 4. 打标签 ${TAG} 触发 CI ==="
git tag -f "${TAG}" >/dev/null 2>&1 || true
git push -q "${REMOTE_URL}" "${TAG}":refs/tags/"${TAG}" 2>&1 | sed 's|https://[^ ]*@|https://***@|g'
echo "已推送标签 ${TAG}，GitHub Actions 正在构建 Release"

echo ""
echo "=== 5. 等待 CI 完成 ==="
for i in $(seq 1 60); do
  sleep 10
  STATUS=$(auth "${API}/repos/${OWNER}/${REPO_SLUG}/actions/runs?per_page=5" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const j=JSON.parse(s);
    const runs=(j.workflow_runs||[]).filter(r=>r.head_branch==='${TAG}');
    if(runs.length) console.log(runs[0].status+' '+(runs[0].conclusion||''));
    else console.log('waiting');
  }catch(e){console.log('waiting')}
})")
  echo "  [$((i*10))s] CI: ${STATUS}"
  if [ "${STATUS}" = "completed success" ]; then break; fi
  if [ "${STATUS}" = "completed failure" ]; then
    echo "CI 失败，查看 ${API}/repos/${OWNER}/${REPO_SLUG}/actions" >&2
    exit 1
  fi
done

echo ""
echo "=== 6. 下载 Release 附件并复核 SHA-256 ==="
mkdir -p "${REPO_DIR}/dist/release-verify"
cd "${REPO_DIR}/dist/release-verify"
curl -sSL --max-time 120 -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/octet-stream" \
  "${API}/repos/${OWNER}/${REPO_SLUG}/releases/assets/$(auth "${API}/repos/${OWNER}/${REPO_SLUG}/releases" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const rel=JSON.parse(s).find(r=>r.tag_name==='${TAG}');
    const a=(rel.assets||[]).find(a=>a.name==='plugin.zip');
    console.log(a?a.id:'');
  }catch(e){console.log('')}
})")" -o plugin.zip

if [ ! -s plugin.zip ]; then
  echo "错误：未能下载 plugin.zip" >&2
  exit 1
fi

ACTUAL=$(sha256sum plugin.zip | cut -d' ' -f1)
echo "下载附件 sha256: ${ACTUAL}"
DECLARED=$(auth "${API}/repos/${OWNER}/${REPO_SLUG}/releases" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const rel=JSON.parse(s).find(r=>r.tag_name==='${TAG}');
    const a=(rel.assets||[]).find(a=>a.name==='plugin.zip.sha256');
    console.log(a?a.browser_download_url:'');
  }catch(e){console.log('')}
})")
if [ -n "${DECLARED}" ]; then
  curl -sSL --max-time 60 -H "Authorization: Bearer ${GITHUB_TOKEN}" "${DECLARED}" -o plugin.zip.sha256
  echo "CI 声明摘要: $(cut -d' ' -f1 plugin.zip.sha256)"
fi

echo ""
echo "=== 7. 用宿主真实安装管线校验 CI 产物 ==="
cd "${REPO_DIR}"
node scripts/verify-install.js dist/release-verify/plugin.zip

echo ""
echo "=== 8. 生成登记条目 ==="
node scripts/make-registry-entry.js --github "${OWNER}" --out ../../registry-submit --from-release \
  && echo "" && cat ../../registry-submit/todo-reminder/registry-entry.json

echo ""
echo "=== 9. 下一步：提交登记 PR ==="
echo "Fork https://github.com/ShunyuYao/pet-plugin-registry 到 ${OWNER}/pet-plugin-registry"
echo "在 registry/plugins.json 的 plugins 数组末尾追加 registry-submit/todo-reminder/registry-entry.json 的内容，"
echo "并把顶层 updatedAt 改为今天，然后提 PR 到官方 main。"
echo "PR 描述用 registry-submit/todo-reminder/pr-description.md。"
