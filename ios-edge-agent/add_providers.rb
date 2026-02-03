#!/usr/bin/env ruby
require 'xcodeproj'

project_path = 'EdgeAgent.xcodeproj'
project = Xcodeproj::Project.open(project_path)

# Find EdgeAgent group and its Bridge subgroup
edgeagent_group = project.main_group.children.find { |g| g.is_a?(Xcodeproj::Project::Object::PBXGroup) && g.name == 'EdgeAgent' }

bridge_group = nil
if edgeagent_group
  bridge_group = edgeagent_group.children.find { |g| g.is_a?(Xcodeproj::Project::Object::PBXGroup) && g.name == 'Bridge' }
end

if bridge_group.nil?
  puts 'Bridge group not found in EdgeAgent group'
  
  # Try path lookup instead
  edgeagent_group = project.main_group.children.find { |g| g.is_a?(Xcodeproj::Project::Object::PBXGroup) && (g.path == 'EdgeAgent' || g.display_name == 'EdgeAgent') }
  if edgeagent_group
    bridge_group = edgeagent_group.children.find { |g| g.is_a?(Xcodeproj::Project::Object::PBXGroup) && (g.path == 'Bridge' || g.display_name == 'Bridge') }
  end
  
  if bridge_group.nil?
    puts 'Still could not find Bridge group, listing all groups:'
    project.main_group.recursive_children.each do |child|
      if child.is_a?(Xcodeproj::Project::Object::PBXGroup)
        puts "  Group: #{child.display_name} (path: #{child.path})"
      end
    end
    exit 1
  end
end

puts "Found Bridge group: #{bridge_group.display_name}"

# Files to add
new_files = %w[
  ClocksProvider.swift
  CliProvider.swift
  HttpOutgoingHandlerProvider.swift
  HttpTypesProvider.swift
  IoErrorProvider.swift
  IoPollProvider.swift
  IoStreamsProvider.swift
  RandomProvider.swift
  SocketsProvider.swift
]

target = project.targets.find { |t| t.name == 'EdgeAgent' }

new_files.each do |filename|
  # Check if already in group
  existing = bridge_group.files.find { |f| f.display_name == filename || f.path == filename }
  if existing
    puts "Already exists: #{filename}"
  else
    file_ref = bridge_group.new_reference("EdgeAgent/Bridge/#{filename}")
    file_ref.source_tree = 'SOURCE_ROOT'
    target.source_build_phase.add_file_reference(file_ref) if target
    puts "Added: #{filename}"
  end
end

project.save
puts 'Project saved successfully'
