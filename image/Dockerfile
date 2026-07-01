# SSH-accessible CUDA development lab. Docker/NVIDIA device integration lives on the host. This
# image installs NVIDIA's minimal CUDA build package rather than inheriting the much larger devel
# image. Students retain password-authenticated sudo. Bubblewrap is setuid-root.

FROM ubuntu:24.04@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54

ENV DEBIAN_FRONTEND=noninteractive
ENV CUDA_HOME=/usr/local/cuda
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

ARG CUDA_KEYRING_SHA256=d2a6b11c096396d868758b86dab1823b25e14d70333f1dfa74da5ddaf6a06dba

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL \
        https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb \
        -o /tmp/cuda-keyring.deb \
    && echo "$CUDA_KEYRING_SHA256  /tmp/cuda-keyring.deb" | sha256sum -c - \
    && dpkg -i /tmp/cuda-keyring.deb \
    && rm -f /tmp/cuda-keyring.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        cuda-minimal-build-13-3=13.3.1-1 \
        openssh-server sudo \
        python3-pip python3-venv python-is-python3 \
        bubblewrap \
        build-essential cmake ninja-build pkg-config \
        git ripgrep procps util-linux nano gnupg \
    && chown root:root /usr/bin/bwrap \
    && chmod 4755 /usr/bin/bwrap \
    && test -u /usr/bin/bwrap \
    && test "$(readlink -f /usr/bin/python)" = "$(readlink -f /usr/bin/python3)" \
    && nvcc --version \
    && printf '%s\n' '__global__ void kernel() {}' 'int main() { return 0; }' \
        > /tmp/cuda-smoke.cu \
    && nvcc -c /tmp/cuda-smoke.cu -o /tmp/cuda-smoke.o \
    && rm -f /tmp/cuda-smoke.cu /tmp/cuda-smoke.o \
    && rm -rf /var/lib/apt/lists/*

# sshd starts login sessions with the distro's safe default PATH instead of the image's inherited
# CUDA PATH. Publish the toolkit through PAM, login shells, and /usr/local/bin so interactive and
# non-interactive SSH commands can both resolve nvcc.
RUN printf '%s\n' \
        'CUDA_HOME=/usr/local/cuda' \
        'PATH=/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
        'LD_LIBRARY_PATH=/usr/local/cuda/lib64' \
        >> /etc/environment \
    && printf '%s\n' \
        'export CUDA_HOME=/usr/local/cuda' \
        'export PATH="$CUDA_HOME/bin:$PATH"' \
        'export LD_LIBRARY_PATH="$CUDA_HOME/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"' \
        > /etc/profile.d/cuda.sh \
    && chmod 0644 /etc/profile.d/cuda.sh \
    && ln -s /usr/local/cuda/bin/nvcc /usr/local/bin/nvcc

# Password SSH remains the initial access mechanism; root login is disabled. Every container creates
# unique host keys on first boot.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?LoginGraceTime.*/LoginGraceTime 30/' /etc/ssh/sshd_config \
    && printf '\nPermitRootLogin no\nMaxAuthTries 3\nLoginGraceTime 30\n' >> /etc/ssh/sshd_config \
    && passwd -l root \
    && mkdir -p /home /cold-storage \
    && rm -f /etc/ssh/ssh_host_*

COPY labquota /usr/local/bin/labquota
COPY entrypoint /usr/local/sbin/lab-entrypoint

RUN chmod 0755 /usr/local/bin/labquota /usr/local/sbin/lab-entrypoint

EXPOSE 22
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/sbin/lab-entrypoint"]
